import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  CONTRACT_FIXTURE_REL_PATH,
  generateContractFixture,
} from '../scripts/sync-contract-fixture.mjs';

test('checked-in K contract fixture matches generated wire shapes', async () => {
  const checkedIn = await readCheckedInFixture();
  const generated = await generateContractFixture();

  assert.deepEqual(generated, checkedIn);
});

test('K contract fixture covers iOS-dependent wire fields', async () => {
  const fixture = await readCheckedInFixture();
  const { cadence, review, build, body, whoop, agui } = fixture.contracts;
  const dayBlock = cadence.daySnapshot.blocks[0];

  assert.equal(dayBlock.actionState, 'started');
  assert.equal(typeof dayBlock.startedAt, 'string');
  assert.equal(typeof dayBlock.elapsedMinutes, 'number');
  assert.equal(typeof dayBlock.recalibrationChange.type, 'string');
  assert.equal(cadence.daySnapshot.recalibration.reason, 'wake-init');
  assert.equal(typeof cadence.nowNextSnapshot.nowBlock.progress, 'number');

  assert.equal(review.valueProbeCard.valueProbes.probes.length > 0, true);
  assert.equal(review.valueProbeCard.valueProbes.answerAction.path, '/api/cadence/value-probes/answers');

  assert.equal(build.card.options.length > 0, true);
  assert.equal(build.cadenceNudge.act.type, 'cadence.nudge.act');
  assert.equal(build.cadenceNudge.act.routesTo.path, '/api/build/cards/answer');
  assert.equal(build.buildSnapshotEnvelope.event, 'build_snapshot');

  assert.equal(body.summary.globalBodyState, 'observed');
  assert.equal(typeof body.cueContext.baselines.samples, 'number');

  assert.equal(whoop.status.configured, true);
  assert.equal(typeof whoop.status.counts.recovery, 'number');

  assert.equal(agui.packetEnvelope.event, 'packet');
  assert.equal(typeof agui.packetEnvelope.data.id, 'string');
  assert.equal(agui.packetEnvelope.data.text, 'fixture delta');
  assert.equal(agui.packetEnvelopes.length >= 2, true);
  assert.equal(agui.patchEnvelope.event, 'packet_patch');
  assert.equal(agui.patchEnvelopes.length >= 1, true);
});

async function readCheckedInFixture() {
  const fixturePath = path.resolve(CONTRACT_FIXTURE_REL_PATH);
  return JSON.parse(await fs.readFile(fixturePath, 'utf8'));
}
