import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertCadenceOpsBlock,
  isCadenceOpsBlock,
  populateCadenceOpsBlocks,
} from './cadence.mjs';
import {
  createOpsGroupStore,
  executeAdminTriageTool,
} from './ops-groups.mjs';
import {
  decideToolCall,
  getAgentTool,
  isReadOnlyTool,
} from './tools.mjs';
import { agentToolExecutor } from '../../daemon/server.mjs';

const fixedNow = () => new Date('2026-07-05T09:00:00.000Z');

test('ops groups populate only scheduled outer operative ops blocks', async () => {
  const dataDir = await tempDataDir();
  const store = createOpsGroupStore({ dataDir, now: fixedNow });
  const group = await store.saveGroup({ title: 'Morning ops' });
  const passport = await store.saveGroupItem({
    groupId: group.id,
    title: 'Check passport renewal',
    sortOrder: 1,
  });
  await store.saveGroupItem({
    groupId: group.id,
    title: 'Clear banking queue',
    sortOrder: 2,
  });
  const completion = await store.recordGroupItemCompletion({
    groupId: group.id,
    itemId: passport.id,
    blockId: 'ops-0900',
    date: '2026-07-05',
    status: 'done',
  });
  const { item: adminItem } = await store.addAdminItem({
    title: 'Renew visa',
    type: 'TimeSensitive',
    effort: 'Quick',
    remindAt: '2026-07-05T09:00:00.000Z',
    dueAt: '2026-09-20T00:00:00.000Z',
  });

  const result = populateCadenceOpsBlocks({
    blocks: [
      block({ id: 'deep-0800', ring: 'core', attentionMode: 'converge' }),
      block({ id: 'mid-0830', ring: 'middle', attentionMode: 'operative' }),
      block({ id: 'ops-0900', ring: 'outer', attentionMode: 'operative', opsBlock: true }),
    ],
    opsGroups: await store.listOpsGroupChecklists({ date: '2026-07-05' }),
    adminItems: [adminItem],
  });

  assert.equal(result.blocks[0].opsChecklist, undefined);
  assert.equal(result.blocks[1].opsChecklist, undefined);
  assert.equal(result.blocks[2].opsChecklist.kind, 'cadence.ops');
  assert.deepEqual(result.blocks[2].opsChecklist.groups.map((entry) => entry.title), ['Morning ops']);
  assert.deepEqual(
    result.blocks[2].opsChecklist.groups[0].items.map((entry) => [entry.title, entry.status]),
    [
      ['Check passport renewal', 'done'],
      ['Clear banking queue', 'pending'],
    ],
  );
  assert.equal(result.blocks[2].opsChecklist.groups[0].items[0].completionId, completion.id);
  assert.deepEqual(result.blocks[2].opsChecklist.adminItems.map((entry) => entry.title), ['Renew visa']);
});

test('hard wall strips accidental admin projections from core and middle blocks', () => {
  const result = populateCadenceOpsBlocks({
    blocks: [
      {
        ...block({ id: 'core-1000', ring: 'core', attentionMode: 'breakthrough' }),
        opsChecklist: { adminItems: [{ title: 'bad' }] },
      },
      {
        ...block({ id: 'middle-1100', ring: 'middle', attentionMode: 'operative' }),
        adminItems: [{ title: 'bad' }],
      },
      block({ id: 'ops-1200', ring: 'outer', attentionMode: 'operative', type: 'ops' }),
    ],
    opsGroups: [],
    adminItems: [{ id: 'adm_demo', title: 'Allowed only in ops', status: 'open' }],
  });

  assert.deepEqual(result.strippedBlockIds, ['core-1000', 'middle-1100']);
  assert.equal(result.blocks[0].opsChecklist, undefined);
  assert.equal(result.blocks[1].adminItems, undefined);
  assert.equal(result.blocks[2].opsChecklist.adminItems[0].title, 'Allowed only in ops');
  assert.equal(isCadenceOpsBlock(result.blocks[2]), true);
  assert.throws(
    () => assertCadenceOpsBlock(block({ id: 'core-1000', ring: 'core', attentionMode: 'operative', opsBlock: true })),
    /core-ring/,
  );
});

test('K admin triage tools write items and stream entries', async () => {
  const dataDir = await tempDataDir();
  const add = await executeAdminTriageTool('admin.add', {
    title: 'Renew passport',
    type: 'TimeSensitive',
    effort: 'Quick',
    remindAt: '2026-07-10T09:00:00.000Z',
    dueAt: '2026-09-20T00:00:00.000Z',
  }, { dataDir, now: fixedNow });
  assert.equal(add.ok, true);
  assert.match(add.output, /admin\.add: streamed/);
  assert.equal(add.artifacts.admin.streamEntry.action, 'add');

  const itemId = add.artifacts.admin.item.id;
  const reschedule = await executeAdminTriageTool('admin.reschedule', {
    itemId,
    remindAt: '2026-07-12T09:00:00.000Z',
  }, { dataDir, now: () => new Date('2026-07-05T09:05:00.000Z') });
  assert.equal(reschedule.ok, true);
  assert.equal(reschedule.artifacts.admin.streamEntry.action, 'reschedule');
  assert.equal(reschedule.artifacts.admin.item.remindAt, '2026-07-12T09:00:00.000Z');

  const complete = await executeAdminTriageTool('admin.complete', {
    itemId,
  }, { dataDir, now: () => new Date('2026-07-05T09:10:00.000Z') });
  assert.equal(complete.ok, true);
  assert.equal(complete.artifacts.admin.streamEntry.action, 'complete');
  assert.equal(complete.artifacts.admin.item.status, 'complete');

  const store = createOpsGroupStore({ dataDir, now: fixedNow });
  const entries = await store.listAdminStreamEntries();
  assert.deepEqual(entries.map((entry) => entry.action), ['add', 'reschedule', 'complete']);
});

test('admin triage tools are registered as internal autonomous tools', () => {
  for (const toolId of ['admin.add', 'admin.reschedule', 'admin.complete']) {
    const tool = getAgentTool(toolId);
    assert.equal(tool.risk.class, 'autonomous');
    assert.equal(tool.readOnly, false);
    assert.equal(isReadOnlyTool(toolId), false);
    assert.equal(decideToolCall({ toolId, args: minimalArgs(toolId) }).action, 'allow');
  }
});

test('daemon agent tool executor routes admin triage tools', async () => {
  const dataDir = await tempDataDir();
  const result = await agentToolExecutor('admin.add', {
    title: 'Book DMV appointment',
    type: 'RegularQueue',
    effort: 'Hour',
  }, { dataDir, now: fixedNow });

  assert.equal(result.ok, true);
  assert.equal(result.artifacts.admin.streamEntry.action, 'add');
});

function block(input) {
  return {
    id: input.id,
    ring: input.ring,
    attentionMode: input.attentionMode,
    description: `${input.id} block`,
    ...(input.opsBlock === undefined ? {} : { opsBlock: input.opsBlock }),
    ...(input.type === undefined ? {} : { type: input.type }),
  };
}

function minimalArgs(toolId) {
  if (toolId === 'admin.add') return { title: 'Renew passport' };
  if (toolId === 'admin.reschedule') return { itemId: 'adm_demo', remindAt: '2026-07-12T09:00:00.000Z' };
  return { itemId: 'adm_demo' };
}

async function tempDataDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-ops-groups-'));
}
