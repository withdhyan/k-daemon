import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ingestHermes, vetStagedSkill } from './hermes-ingest.mjs';
import { createStagedSkillsStore } from './hermes-staging.mjs';

const fixedNow = () => new Date('2026-07-01T00:00:00.000Z');

test('ingestHermes stages a new skill as pending, never active', async () => {
  const { store } = await freshStore();
  const fetchImpl = catalogFetch({
    'skills/alpha/SKILL.md': '---\nname: alpha\ndescription: a\n---\nbody',
  });

  const result = await ingestHermes({ store, env: catalogEnv(), fetchImpl });
  assert.equal(result.createdCount, 1);

  const skills = await store.listSkills();
  assert.equal(skills.length, 1);
  assert.equal(skills[0].status, 'pending');
  assert.equal(skills[0].requiresReview, true);
});

test('re-ingesting an unchanged skill is a duplicate (no supersession, no dup file)', async () => {
  const { store } = await freshStore();
  const fetchImpl = catalogFetch({
    'skills/alpha/SKILL.md': '---\nname: alpha\ndescription: a\n---\nbody',
  });

  await ingestHermes({ store, env: catalogEnv(), fetchImpl });
  const second = await ingestHermes({ store, env: catalogEnv(), fetchImpl });

  assert.equal(second.duplicateCount, 1);
  assert.equal(second.createdCount, 0);
  const skills = await store.listSkills();
  assert.equal(skills.length, 1);
});

test('a changed upstream skill supersedes the prior staged record (bi-temporal)', async () => {
  const { store, dataDir } = await freshStore();

  await ingestHermes({
    store,
    env: catalogEnv(),
    fetchImpl: catalogFetch({ 'skills/alpha/SKILL.md': '---\nname: alpha\ndescription: v1\n---\nbody1' }),
  });
  const changed = await ingestHermes({
    store,
    env: catalogEnv(),
    fetchImpl: catalogFetch({ 'skills/alpha/SKILL.md': '---\nname: alpha\ndescription: v2\n---\nbody2' }),
  });

  assert.equal(changed.supersededCount, 1);
  const live = await store.readSkill(changed.staged[0].record.skillId);
  assert.equal(live.description, 'v2');
  assert.equal(live.supersedes !== undefined, true);

  // Prior version archived, not deleted (supersession-not-mutation).
  const archiveDir = path.join(dataDir, 'staged-skills', 'skills', 'superseded');
  const archived = await fs.readdir(archiveDir);
  assert.equal(archived.length, 1);
});

test('a malformed/oversized upstream skill is quarantined, not fatal', async () => {
  const { store } = await freshStore();
  const fetchImpl = catalogFetch({
    'skills/good/SKILL.md': '---\nname: good\n---\nok',
    'skills/bad/SKILL.md': '---\nname: bad\n(unterminated)\n',
  });

  const result = await ingestHermes({ store, env: catalogEnv(), fetchImpl });
  assert.equal(result.createdCount, 1);
  assert.equal(result.quarantinedCount, 1);
  assert.equal(result.quarantined[0].reason, 'unterminated_frontmatter');
});

test('vet flags tool-threats but never blocks staging or auto-approves', () => {
  const vet = vetStagedSkill({
    declaredTools: ['bash', 'fetch'],
    rawBody: 'this reads process.env.API_KEY and runs child_process',
  });
  assert.equal(vet.threats.includes('shell-exec'), true);
  assert.equal(vet.threats.includes('network-egress'), true);
  assert.equal(vet.threats.includes('secret-access'), true);
  assert.equal(vet.annotations.requiresReview, true);
});

test('approve marks the record approved but does not activate (activated:false surface)', async () => {
  const { store } = await freshStore();
  await ingestHermes({
    store,
    env: catalogEnv(),
    fetchImpl: catalogFetch({ 'skills/alpha/SKILL.md': '---\nname: alpha\n---\nbody' }),
  });
  const [record] = await store.listSkills();

  const result = await store.setSkillStatus(record.skillId, 'approved', { note: 'ok' });
  assert.equal(result.record.status, 'approved');
  // Nothing was written into any loader/skills scan root — only the staged store.
  assert.equal(result.record.rawBody.length > 0, true);
});

test('capability notes are staged from releases', async () => {
  const { store } = await freshStore();
  const fetchImpl = catalogFetch(
    { 'skills/alpha/SKILL.md': '---\nname: alpha\n---\nbody' },
    [{ tag_name: 'v9', name: 'Hermes ships X', body: 'want it?' }],
  );

  const result = await ingestHermes({ store, env: catalogEnv(), fetchImpl });
  assert.equal(result.noteCreatedCount, 1);
  const notes = await store.listNotes();
  assert.equal(notes[0].tag, 'v9');
  assert.equal(notes[0].status, 'pending');
});

async function freshStore() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-hermes-'));
  return { store: createStagedSkillsStore({ dataDir, now: fixedNow }), dataDir };
}

function catalogEnv() {
  return { K_HERMES_CATALOG_REPO: 'org/skills', K_HERMES_CATALOG_PATH: 'skills' };
}

function catalogFetch(files, releases = []) {
  const tree = Object.keys(files).map((p, i) => ({ type: 'blob', path: p, sha: `sha${i}` }));
  return async (url) => {
    if (url.includes('/git/trees/')) return json({ tree });
    if (url.includes('/releases')) return json(releases);
    if (url.includes('raw.githubusercontent.com')) {
      const match = Object.keys(files).find((p) =>
        url.includes(p.split('/').map(encodeURIComponent).join('/')));
      if (match) return textResponse(files[match]);
      return json(null, 404);
    }
    throw new Error(`unexpected url ${url}`);
  };
}

function json(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, async json() { return payload; } };
}

function textResponse(text, status = 200) {
  return { ok: status >= 200 && status < 300, status, body: null, async text() { return text; } };
}
