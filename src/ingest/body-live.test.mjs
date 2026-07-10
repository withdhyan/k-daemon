import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  BODY_LIVE_BUDGET_QUEUED,
  BODY_LIVE_NO_CUE,
  bodyLiveCueResponse,
  createBodyLiveState,
} from './body-live.mjs';
import { ATTENTION_CATEGORY_BODY_CUE } from '../agent/attention-budget.mjs';
import { SURFACE_REASONS } from '../agent/suppressor.mjs';
import { validateViewPacket } from '../agent/view-packet.mjs';

const fixedNow = () => new Date('2026-07-05T00:00:00.000Z');
const baseline = Object.freeze({ hrv: 62, samples: 6 });

test('live body route stays silent when the signal does not earn a cue', () => {
  const response = bodyLiveCueResponse(
    { source: 'healthkit', hrv_ms: 55 },
    { baselines: baseline, now: fixedNow, state: createBodyLiveState() },
  );

  assert.equal(response.ok, true);
  assert.equal(response.silenced, true);
  assert.equal(response.reason, BODY_LIVE_NO_CUE);
  assert.deepEqual(response.packets, []);
  assert.equal(response.surfaceDecision.surface, false);
});

test('low instant HRV becomes a validated advisory AG-UI packet when it earns interruption', () => {
  const response = bodyLiveCueResponse(
    { source: 'healthkit', hrv_ms: 38, timestamp: '2026-07-05T00:00:00.000Z' },
    { baselines: baseline, now: fixedNow, state: createBodyLiveState() },
  );

  assert.equal(response.ok, true);
  assert.equal(response.silenced, false);
  assert.equal(response.surfaceDecision.reason, SURFACE_REASONS.PASSED);
  assert.equal(response.packets.length, 1);

  const packet = response.packet;
  assert.equal(validateViewPacket(packet), packet);
  assert.equal(packet.viewType, 'generic.card');
  assert.equal(packet.frontierExcluded, true);
  assert.equal(packet.provenance.surface, 'body');
  assert.equal(packet.provenance.module, 'body-live');
  assert.equal(packet.fields.status, 'interrupt');
  assert.equal(packet.fields.advisoryOnly, true);
  assert.equal(packet.fields.cueKind, 'hrv_drop');
  assert.equal(packet.fields.hrvMs, 38);
  assert.equal(packet.fields.baselineHrvMs, 62);
  assert.equal(packet.action.tag, '[advise]');
});

test('focus attention suppresses a non-critical body cue', () => {
  const response = bodyLiveCueResponse(
    { source: 'healthkit', hrv_ms: 38, attentionState: 'focus' },
    { baselines: baseline, now: fixedNow, state: createBodyLiveState() },
  );

  assert.equal(response.silenced, true);
  assert.equal(response.reason, SURFACE_REASONS.DEEP_FOCUS);
  assert.equal(response.surfaceDecision.surface, false);
  assert.deepEqual(response.packets, []);
});

test('critical body cues can pass through focus gating', () => {
  const response = bodyLiveCueResponse(
    { source: 'healthkit', hrv_ms: 20, attentionState: 'focus' },
    { baselines: baseline, now: fixedNow, state: createBodyLiveState() },
  );

  assert.equal(response.silenced, false);
  assert.equal(response.cue.critical, true);
  assert.equal(response.packet.fields.critical, true);
  assert.equal(validateViewPacket(response.packet), response.packet);
});

test('low EEG attention is routed as an advisory packet when signal quality supports it', () => {
  const response = bodyLiveCueResponse(
    { source: 'neurosity', eeg: { attention: 0.2, signalQuality: 0.95 } },
    { now: fixedNow, state: createBodyLiveState() },
  );

  assert.equal(response.silenced, false);
  assert.equal(response.packet.fields.cueKind, 'attention_dip');
  assert.equal(response.packet.fields.signal, 'attention');
  assert.equal(response.packet.fields.source, 'eeg');
  assert.equal(response.packet.fields.attentionScore, 0.2);
  assert.equal(validateViewPacket(response.packet), response.packet);
});

test('recently surfaced body cue is silenced by suppressor cooldown', () => {
  const state = createBodyLiveState();
  const first = bodyLiveCueResponse(
    { source: 'healthkit', hrv_ms: 38 },
    { baselines: baseline, now: fixedNow, state },
  );
  const second = bodyLiveCueResponse(
    { source: 'healthkit', hrv_ms: 37 },
    { baselines: baseline, now: fixedNow, state },
  );

  assert.equal(first.silenced, false);
  assert.equal(second.silenced, true);
  assert.equal(second.reason, SURFACE_REASONS.RECENCY_COOLDOWN);
  assert.deepEqual(second.packets, []);
});

test('body live cues queue after the daily attention budget cap', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-body-budget-'));
  const caps = { [ATTENTION_CATEGORY_BODY_CUE]: 1 };

  const first = bodyLiveCueResponse(
    { source: 'healthkit', hrv_ms: 38, timestamp: '2026-07-05T09:00:00.000Z' },
    { dataDir, attentionBudgetCaps: caps, baselines: baseline, now: fixedNow, state: createBodyLiveState() },
  );
  const second = bodyLiveCueResponse(
    { source: 'healthkit', hrv_ms: 37, timestamp: '2026-07-05T09:01:00.000Z' },
    {
      dataDir,
      attentionBudgetCaps: caps,
      baselines: baseline,
      now: () => new Date('2026-07-05T09:01:00.000Z'),
      state: createBodyLiveState(),
    },
  );

  assert.equal(first.silenced, false);
  assert.equal(second.silenced, true);
  assert.equal(second.reason, BODY_LIVE_BUDGET_QUEUED);
  assert.equal(second.attentionBudget.queuedUntil, '2026-07-06T06:00:00.000Z');
  assert.deepEqual(second.packets, []);
});
