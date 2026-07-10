import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  commitAdminParseConfirm,
  createAdminStore,
  executeAdminParseIntakeTool,
  normalizeAdminParsedFields,
  parseAdminIntakeWithK,
} from './admin.mjs';

const fixedNow = () => new Date('2026-07-05T09:00:00.000Z');

test('admin NLP intake goes through the same K native tool-call path and returns parse-confirm', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-admin-parse-'));
  const observed = [];
  const model = async (request) => {
    observed.push(request);
    if (observed.length === 1) {
      return {
        content: '',
        toolCalls: [{
          id: 'call_parse',
          name: 'admin.parse_intake',
          arguments: JSON.stringify({
            title: 'renew visa',
            type: 'TimeSensitive',
            effort: 'Quick',
            remindDate: '2026-09-01',
            dueDate: '2026-09-20',
            note: 'needs founder paperwork',
          }),
        }],
      };
    }
    return 'ready for confirm';
  };

  const result = await parseAdminIntakeWithK(
    { text: 'add: renew visa by sep 20, remind sep 1' },
    {
      dataDir,
      now: fixedNow,
      deps: {
        frontierModelCall: async () => {
          throw new Error('frontier must not run for admin intake');
        },
        sovereignModelCall: model,
        toolExecutor: (toolId, args) => executeAdminParseIntakeTool(args, { now: fixedNow }),
      },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.state, 'parse_confirm');
  assert.equal(result.sovereign, true);
  assert.equal(observed.length, 2);
  assert.deepEqual(
    observed[0].tools.map((tool) => tool.function.name),
    ['admin.parse_intake'],
  );
  assert.equal(result.parseConfirm.kind, 'admin.parse_confirm');
  assert.equal(result.parseConfirm.committed, false);
  assert.equal(result.parseConfirm.sourceText, 'add: renew visa by sep 20, remind sep 1');
  assert.deepEqual(result.parseConfirm.parsed, {
    title: 'renew visa',
    type: 'TimeSensitive',
    effort: 'Quick',
    remindDate: '2026-09-01',
    dueDate: '2026-09-20',
    note: 'needs founder paperwork',
    warnings: [],
  });
  assert.deepEqual(await createAdminStore({ dataDir, now: fixedNow }).listBandish(), []);
});

test('parse-confirm commits only after explicit confirm payload', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-admin-confirm-'));
  const parseConfirm = executeAdminParseIntakeTool({
    sourceText: 'add: renew visa by sep 20, remind sep 1',
    title: 'renew visa',
    type: 'TimeSensitive',
    effort: 'Quick',
    remindDate: '2026-09-01',
    dueDate: '2026-09-20',
  }, { now: fixedNow }).artifacts.adminParseConfirm;

  assert.deepEqual(await createAdminStore({ dataDir, now: fixedNow }).listBandish(), []);

  const committed = await commitAdminParseConfirm(parseConfirm.confirmAction.body, {
    dataDir,
    now: fixedNow,
  });
  assert.equal(committed.ok, true);
  assert.equal(committed.created, true);
  assert.equal(committed.item.kind, 'AdminBandish');
  assert.equal(committed.item.title, 'renew visa');
  assert.equal(committed.item.remindDate, '2026-09-01');
  assert.equal(committed.item.dueDate, '2026-09-20');

  const items = await createAdminStore({ dataDir, now: fixedNow }).listBandish();
  assert.equal(items.length, 1);
  assert.equal(items[0].id, committed.item.id);
});

test('admin item listing sorts by remind date then due date then effort', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-admin-sort-'));

  await commitAdminParseConfirm({
    parsed: {
      title: 'hour item',
      type: 'TimeSensitive',
      effort: 'Hour',
      remindDate: '2026-09-01',
      dueDate: '2026-09-30',
    },
  }, { dataDir, now: fixedNow });
  await commitAdminParseConfirm({
    parsed: {
      title: 'quick item',
      type: 'TimeSensitive',
      effort: 'Quick',
      remindDate: '2026-09-01',
      dueDate: '2026-09-30',
    },
  }, { dataDir, now: fixedNow });
  await commitAdminParseConfirm({
    parsed: {
      title: 'earlier remind',
      type: 'TimeSensitive',
      effort: 'Hours',
      remindDate: '2026-08-15',
      dueDate: '2026-09-30',
    },
  }, { dataDir, now: fixedNow });

  const items = await createAdminStore({ dataDir, now: fixedNow }).listBandish();
  assert.deepEqual(items.map((item) => item.title), [
    'earlier remind',
    'quick item',
    'hour item',
  ]);
});

test('admin parsed fields reject impossible date-only strings', () => {
  assert.throws(() => normalizeAdminParsedFields({
    title: 'bad date',
    type: 'TimeSensitive',
    effort: 'Quick',
    remindDate: '2026-99-99',
    dueDate: '2026-09-20',
  }), /invalid_remindDate/);
});

test('admin parsed fields preserve date-only prefix from ISO datetimes', () => {
  const parsed = normalizeAdminParsedFields({
    title: 'timezone date',
    type: 'TimeSensitive',
    effort: 'Quick',
    remindDate: '2026-09-01T00:00:00+07:00',
    dueDate: '2026-09-20T00:00:00+07:00',
  });

  assert.equal(parsed.remindDate, '2026-09-01');
  assert.equal(parsed.dueDate, '2026-09-20');
});
