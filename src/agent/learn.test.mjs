import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createStagedSkillsStore } from '../ingest/hermes-staging.mjs';
import { SKILL_TOOL_GRANTS, loadSkillGrants } from './skill-grants.mjs';
import {
  buildLearnPrompt,
  contentHashFor,
  executeLearnTool,
  learnSkillIdFor,
  runLearn,
  validateLearnSkill,
} from './learn.mjs';

const fixedNow = () => new Date('2026-07-02T12:00:00.000Z');

const VALID_SKILL = `---
name: source-triage
description: Triage source quality for K research.
author: K
allowed-tools:
  - skill.view
  - web.fetch
---

## When-to-Use
Use when K needs to decide whether a research source is worth reading.

## Prerequisites
- A user request or a gathered source excerpt exists.

## How-to-Run
1. Use skill.view for approved skills and web.fetch for public pages.

## Quick-Reference
- Prefer primary sources.

## Procedure
1. Identify claims.
2. Check evidence.
3. Return the smallest useful conclusion.

## Pitfalls
- Do not treat summaries as primary evidence.

## VERIFICATION
- Given a source list, the skill returns accepted and rejected sources with reasons.

## Provenance
- path: docs/plans/2026-07-02-002-feat-general-agent-phase-plan.md
- conversation: GA-5 task 13
`;

test('buildLearnPrompt embeds the GA-5 hardline standards in one prompt', () => {
  const prompt = buildLearnPrompt({
    request: 'Learn source triage.',
    sources: [{ path: 'docs/source.md', text: 'Use source evidence.' }],
  });

  assert.match(prompt, /description <=60 chars/);
  assert.match(prompt, /When-to-Use -> Prerequisites -> How-to-Run -> Quick-Reference -> Procedure -> Pitfalls -> VERIFICATION/);
  assert.match(prompt, /author: K/);
  assert.match(prompt, /Provenance/);
  assert.match(prompt, /skill\.view/);
  assert.match(prompt, /web\.fetch/);
  assert.match(prompt, /never cat or curl/i);
  assert.match(prompt, /docs\/source\.md/);
});

test('standards validation rejects descriptions past the 60-char routing budget', () => {
  const longDescription = 'x'.repeat(61);
  const result = validateLearnSkill(VALID_SKILL.replace(
    'description: Triage source quality for K research.',
    `description: ${longDescription}`,
  ));

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'description_too_long');
});

test('standards validation rejects a missing VERIFICATION section', () => {
  const result = validateLearnSkill(VALID_SKILL.replace(
    /\n## VERIFICATION[\s\S]*?\n## Provenance/,
    '\n## Provenance',
  ));

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing_verification');
});

test('standards validation rejects a non-K author', () => {
  const result = validateLearnSkill(VALID_SKILL.replace('author: K', 'author: local-user'));

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'author_not_k');
});

test('standards validation rejects missing provenance', () => {
  const result = validateLearnSkill(VALID_SKILL.replace(/\n## Provenance[\s\S]*$/, '\n'));

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing_provenance');
});

test('skill.manage supports create and edit only', async () => {
  const dataDir = await tempDataDir();
  const deleted = await executeLearnTool('skill.manage', {
    action: 'delete',
    rawBody: VALID_SKILL,
  }, { dataDir, now: fixedNow });

  assert.equal(deleted.ok, false);
  assert.equal(deleted.reason, 'unsupported_action');

  const created = await executeLearnTool('skill.manage', {
    action: 'create',
    rawBody: VALID_SKILL,
  }, { dataDir, now: fixedNow });
  assert.equal(created.ok, true);

  const edited = await executeLearnTool('skill.manage', {
    action: 'edit',
    rawBody: VALID_SKILL.replace('Prefer primary sources.', 'Prefer source owners.'),
  }, { dataDir, now: fixedNow });
  assert.equal(edited.ok, true);
});

test('skill.manage stages K-authored skills as pending and never approves', async () => {
  const dataDir = await tempDataDir();
  const store = createStagedSkillsStore({ dataDir, now: fixedNow });

  const result = await executeLearnTool('skill.manage', {
    action: 'create',
    rawBody: VALID_SKILL,
  }, { store });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'pending');
  assert.equal(result.pendingPath, `staged-skills/skills/${result.skillId}.json`);

  const staged = await store.readSkill(result.skillId);
  assert.equal(staged.status, 'pending');
  assert.equal(staged.surface, 'k-authored');
  assert.equal(staged.requiresReview, true);
  assert.equal(staged.contentHash, contentHashFor(VALID_SKILL));
});

test('skill.manage does not escalate pending skills into active grants', async () => {
  const dataDir = await tempDataDir();
  const grantsBefore = JSON.stringify(SKILL_TOOL_GRANTS);
  const grantMappedSkill = VALID_SKILL.replace('name: source-triage', 'name: duckduckgo-search');

  const result = await executeLearnTool('skill.manage', {
    action: 'create',
    rawBody: grantMappedSkill,
  }, { dataDir, now: fixedNow });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'pending');
  assert.equal(JSON.stringify(SKILL_TOOL_GRANTS), grantsBefore);
  assert.deepEqual([...(await loadSkillGrants({ dataDir }))], ['memory.search']);
});

test('skill id and content hash are deterministic', () => {
  assert.equal(
    learnSkillIdFor('source-triage'),
    `skl-${sha256('source-triage').slice(0, 24)}`,
  );
  assert.equal(contentHashFor(VALID_SKILL), sha256(VALID_SKILL));
  assert.equal(learnSkillIdFor('source-triage'), learnSkillIdFor('source-triage'));
  assert.equal(contentHashFor(VALID_SKILL), contentHashFor(VALID_SKILL));
});

test('runLearn gathers sources, drafts one skill, validates, stages, and returns gist plus preview', async () => {
  const seen = {};
  const result = await runLearn({
    request: 'Learn source triage.',
    gather: async ({ request }) => {
      seen.request = request;
      return [{ path: 'docs/source.md', text: 'Prefer primary sources.' }];
    },
    draft: async ({ prompt, sources }) => {
      seen.prompt = prompt;
      seen.sources = sources;
      return VALID_SKILL;
    },
    stage: async (input) => ({
      record: {
        ...input,
        status: 'pending',
      },
      outcome: 'created',
    }),
  });

  assert.equal(seen.request, 'Learn source triage.');
  assert.match(seen.prompt, /Prefer primary sources/);
  assert.equal(seen.sources.length, 1);
  assert.equal(result.skillId, learnSkillIdFor('source-triage'));
  assert.equal(result.pendingPath, `staged-skills/skills/${result.skillId}.json`);
  assert.equal(result.gist, 'Triage source quality for K research.');
  assert.equal(result.diffPreview.split('\n').length <= 40, true);
  assert.match(result.diffPreview, /^\+---/);
});

async function tempDataDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-learn-'));
}

function sha256(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}
