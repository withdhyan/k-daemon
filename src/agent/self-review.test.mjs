import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createStagedSkillsStore } from '../ingest/hermes-staging.mjs';
import { addNote, readNoteEntries } from './notes.mjs';
import { listPendingNoteProposals, readPendingNoteProposal } from './notes-pending.mjs';
import { SELF_REVIEW_QUESTION, buildSelfReviewRequest, runSelfReview } from './self-review.mjs';
import {
  MAX_SURFACED_PER_HOUR,
  MIN_CONFIDENCE,
  MIN_RELEVANCE,
  SURFACE_REASONS,
} from './suppressor.mjs';

const fixedNow = () => new Date('2026-07-02T12:00:00.000Z');
const CONVO = 'founder: Please remember that K should use terse citations.';
const EVIDENCE = 'K should use terse citations';

test('self-review asks one question through the model request', () => {
  const request = buildSelfReviewRequest({ conversationSnapshot: CONVO, now: fixedNow });
  assert.equal((request.user.match(new RegExp(escapeRegExp(SELF_REVIEW_QUESTION), 'g')) ?? []).length, 1);
  assert.equal(request.tool.name, 'self_review_proposals');
});

test('governance-path proposal is rejected as immutable_governance_core', async () => {
  const dataDir = await tempDataDir();
  const result = await runSelfReview({
    conversationSnapshot: CONVO,
    dataDir,
    now: fixedNow,
    logger: quietLogger(),
    singleCall: async () => ({
      proposals: [{
        kind: 'note',
        action: 'add',
        targetPath: 'src/next-action.mjs',
        text: 'Never touch governance.',
        evidence: EVIDENCE,
      }],
    }),
  });

  assert.equal(result.staged.length, 0);
  assert.equal(result.rejected[0].reason, 'immutable_governance_core');
});

test('code-path proposal is rejected as gated_target', async () => {
  const dataDir = await tempDataDir();
  const result = await runSelfReview({
    conversationSnapshot: CONVO,
    dataDir,
    now: fixedNow,
    logger: quietLogger(),
    singleCall: async () => ({
      proposals: [{
        kind: 'skill',
        action: 'create',
        targetPath: 'daemon/server.mjs',
        rawBody: VALID_SKILL,
        evidence: EVIDENCE,
      }],
    }),
  });

  assert.equal(result.staged.length, 0);
  assert.equal(result.rejected[0].reason, 'gated_target');
});

test('note proposals stage only and do not write NOTES.md directly', async () => {
  const dataDir = await tempDataDir();
  const result = await runSelfReview({
    conversationSnapshot: CONVO,
    dataDir,
    now: fixedNow,
    logger: quietLogger(),
    singleCall: async () => ({
      proposals: [{
        kind: 'note',
        action: 'add',
        targetPath: 'data/notes/NOTES.md',
        directWrite: true,
        text: 'Use terse citations in web answers.',
        evidence: EVIDENCE,
      }],
    }),
  });

  assert.equal(result.staged.length, 1);
  assert.equal(result.staged[0].kind, 'PendingNoteProposal');
  assert.deepEqual(await readNoteEntries({ dataDir }), []);

  const pending = await listPendingNoteProposals({ dataDir });
  assert.equal(pending.pendingCount, 1);
  const record = await readPendingNoteProposal(pending.notes[0].proposalId, { dataDir });
  assert.equal(record.payload.action, 'add');
  assert.equal(record.payload.text, 'Use terse citations in web answers.');
});

test('high-relevance high-confidence self-review proposal surfaces its notification', async () => {
  const dataDir = await tempDataDir();
  const { logger, infos } = captureLogger();
  const result = await runSelfReview({
    conversationSnapshot: CONVO,
    dataDir,
    now: fixedNow,
    logger,
    singleCall: async () => ({
      proposals: [{
        kind: 'note',
        action: 'add',
        targetPath: 'data/notes/NOTES.md',
        text: 'Use terse citations in web answers.',
        evidence: EVIDENCE,
        relevance: Math.min(1, MIN_RELEVANCE + 0.2),
        confidence: Math.min(1, MIN_CONFIDENCE + 0.1),
      }],
    }),
  });

  assert.equal(result.staged.length, 1);
  assert.equal(result.notification.surface, true);
  assert.equal(result.notification.suppressed, false);
  assert.equal(result.notification.reason, SURFACE_REASONS.PASSED);
  assert.match(result.notification.text, /💾 self-improvement review/);
  assert.deepEqual(infos, [result.notification.text]);
});

test('low-relevance self-review proposal is suppressed but still staged pending', async () => {
  const dataDir = await tempDataDir();
  const { logger, infos } = captureLogger();
  const result = await runSelfReview({
    conversationSnapshot: CONVO,
    dataDir,
    now: fixedNow,
    logger,
    singleCall: async () => ({
      proposals: [{
        kind: 'note',
        action: 'add',
        targetPath: 'data/notes/NOTES.md',
        text: 'Use terse citations in web answers.',
        evidence: EVIDENCE,
        relevance: Math.max(0, MIN_RELEVANCE - 0.01),
        confidence: MIN_CONFIDENCE,
      }],
    }),
  });

  assert.equal(result.staged.length, 1);
  assert.equal(result.suppressed, true);
  assert.equal(result.notification.suppressed, true);
  assert.equal(result.notification.reason, SURFACE_REASONS.LOW_RELEVANCE);
  assert.equal(result.reason, SURFACE_REASONS.LOW_RELEVANCE);
  assert.deepEqual(infos, []);

  const pending = await listPendingNoteProposals({ dataDir });
  assert.equal(pending.pendingCount, 1);
  const record = await readPendingNoteProposal(pending.notes[0].proposalId, { dataDir });
  assert.equal(record.status, 'pending');
  assert.equal(record.payload.text, 'Use terse citations in web answers.');
});

test('self-review surfacing respects the hourly rate window', async () => {
  const dataDir = await tempDataDir();
  const { logger, infos } = captureLogger();
  const result = await runSelfReview({
    conversationSnapshot: CONVO,
    dataDir,
    now: fixedNow,
    logger,
    lastSurfacedAt: new Date(fixedNow().getTime() - 5 * 60 * 1000),
    surfacedCountThisHour: MAX_SURFACED_PER_HOUR,
    singleCall: async () => ({
      proposals: [{
        kind: 'note',
        action: 'add',
        targetPath: 'data/notes/NOTES.md',
        text: 'Use terse citations in web answers.',
        evidence: EVIDENCE,
        relevance: MIN_RELEVANCE,
        confidence: MIN_CONFIDENCE,
      }],
    }),
  });

  assert.equal(result.staged.length, 1);
  assert.equal(result.notification.suppressed, true);
  assert.equal(result.notification.reason, SURFACE_REASONS.RATE_LIMIT);
  assert.deepEqual(infos, []);

  const pending = await listPendingNoteProposals({ dataDir });
  assert.equal(pending.pendingCount, 1);
});

test('evidence-less proposals are dropped', async () => {
  const dataDir = await tempDataDir();
  const result = await runSelfReview({
    conversationSnapshot: CONVO,
    dataDir,
    now: fixedNow,
    logger: quietLogger(),
    singleCall: async () => ({
      proposals: [{
        kind: 'note',
        action: 'add',
        text: 'Store this without evidence.',
        evidence: 'This excerpt is not in the conversation.',
      }],
    }),
  });

  assert.equal(result.staged.length, 0);
  assert.equal(result.rejected[0].reason, 'evidence_required');
  assert.equal((await listPendingNoteProposals({ dataDir })).pendingCount, 0);
});

test('note replace/remove proposals require quoted existing entry text', async () => {
  const dataDir = await tempDataDir();
  await addNote('Existing operational note: cite fetched URLs.', { dataDir });

  const result = await runSelfReview({
    conversationSnapshot: CONVO,
    dataDir,
    now: fixedNow,
    logger: quietLogger(),
    singleCall: async () => ({
      proposals: [{
        kind: 'note',
        action: 'replace',
        existingText: 'cite fetched URLs',
        replacement: 'Existing operational note: cite fetched URLs concisely.',
        evidence: EVIDENCE,
      }],
    }),
  });

  assert.equal(result.staged.length, 0);
  assert.equal(result.rejected[0].reason, 'read_before_write_violation');
});

test('skill proposals stage as StagedSkillProposal through the GA-5 learn path', async () => {
  const dataDir = await tempDataDir();
  const result = await runSelfReview({
    conversationSnapshot: `${CONVO}\nfounder: Learn source triage from this exchange.`,
    dataDir,
    now: fixedNow,
    logger: quietLogger(),
    singleCall: async () => ({
      proposals: [{
        kind: 'skill',
        action: 'create',
        target: 'staged skill',
        gist: 'Stage source-triage skill.',
        rawBody: VALID_SKILL,
        evidence: 'Learn source triage from this exchange',
        beforeAfterMeasure: 'Run source-triage held-out examples before approval.',
      }],
    }),
  });

  assert.equal(result.rejected.length, 0);
  assert.equal(result.staged.length, 1);
  assert.equal(result.staged[0].kind, 'StagedSkillProposal');
  assert.equal(result.staged[0].origin, 'self_review');

  const store = createStagedSkillsStore({ dataDir, now: fixedNow });
  const record = await store.readSkill(result.staged[0].skillId);
  assert.equal(record.kind, 'StagedSkillProposal');
  assert.equal(record.origin, 'self_review');
  assert.deepEqual(record.proposalEvidence, ['Learn source triage from this exchange']);
  assert.equal(record.beforeAfterMeasure, 'Run source-triage held-out examples before approval.');
  assert.equal(record.status, 'pending');
});

async function tempDataDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-self-review-'));
}

function quietLogger() {
  return { warn() {} };
}

function captureLogger() {
  const infos = [];
  return {
    infos,
    logger: {
      info(message) { infos.push(message); },
      warn() {},
    },
  };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const VALID_SKILL = `---
name: source-triage
description: Triage evidence from self-review conversations.
author: K
allowed-tools:
  - skill.view
  - web.fetch
---

## When-to-Use
Use when K needs to judge source evidence from a conversation.

## Prerequisites
- A conversation excerpt exists.

## How-to-Run
1. Use skill.view for approved skills and web.fetch for public pages.

## Quick-Reference
- Keep only claims with evidence.

## Procedure
1. Extract the claim.
2. Match it to evidence.
3. Return the smallest useful note.

## Pitfalls
- Do not invent sources.

## VERIFICATION
- Given a conversation excerpt, the skill returns accepted and rejected claims.

## Provenance
- conversation: Learn source triage from this exchange.
`;
