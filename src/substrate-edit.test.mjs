import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import {
  SUBSTRATE_CORRECT_PATH,
  SUBSTRATE_MERGE_PATH,
  SUBSTRATE_REDACT_PATH,
  handleSubstrateEdit,
} from '../daemon/routes/substrate-edit.mjs';
import { createSubstrateStore } from './substrate.mjs';

const fixedNow = () => new Date('2026-07-03T09:00:00.000Z');

test('correct writes a superseding Exposure and leaves only the correction live', async () => {
  const store = await freshStore();
  const original = await store.writeExposure(exposureInput('original', 'Original substrate claim.'));

  const response = await dispatchRoute({
    store,
    pathname: SUBSTRATE_CORRECT_PATH,
    payload: {
      id: original.id,
      statement: 'Corrected substrate claim.',
      context: 'Founder corrected this during curation.',
    },
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.supersededId, original.id);
  assert.notEqual(response.body.id, original.id);

  const retired = await store.readRecord(original.id);
  const correction = await store.readRecord(response.body.id);
  const live = liveRecords(await store.listRecords('Exposure'));

  assert.equal(retired.supersededById, correction.id);
  assert.equal(retired.validTo, '2026-07-03T09:00:00.000Z');
  assert.equal(correction.statement, 'Corrected substrate claim.');
  assert.equal(correction.context, 'Founder corrected this during curation.');
  assert.deepEqual(correction.provenance, original.provenance);
  assert.deepEqual(live.map((record) => record.id), [correction.id]);
  assert.equal((await store.listRecords('Exposure')).length, 2);
  assert.equal((await store.readRecord(original.id)).statement, original.statement);
});

test('redact writes a non-live tombstone and keeps the original in full history', async () => {
  const store = await freshStore();
  const original = await store.writeExposure(exposureInput('secret', 'Sensitive statement to redact.'));

  const response = await dispatchRoute({
    store,
    pathname: SUBSTRATE_REDACT_PATH,
    payload: { id: original.id },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { ok: true, redacted: original.id });

  const retired = await store.readRecord(original.id);
  const tombstone = await store.readRecord(retired.supersededById);
  const all = await store.listRecords('Exposure');

  assert.equal(retired.statement, 'Sensitive statement to redact.');
  assert.equal(retired.validTo, '2026-07-03T09:00:00.000Z');
  assert.equal(tombstone.tombstone, true);
  assert.equal(tombstone.redacted, true);
  assert.equal(tombstone.validTo, '2026-07-03T09:00:00.000Z');
  assert.equal(tombstone.metadata.curation.redactedId, original.id);
  assert.deepEqual(liveRecords(all), []);
  assert.equal(liveSourceCount(all, original.provenance.surface), 0);
  assert.equal(all.length, 2);
});

test('merge retires non-canonical records to the canonical survivor', async () => {
  const store = await freshStore();
  const canonical = await store.writeExposure(exposureInput('canonical', 'Canonical record.'));
  const duplicateA = await store.writeExposure(exposureInput('duplicate-a', 'Duplicate record A.'));
  const duplicateB = await store.writeExposure(exposureInput('duplicate-b', 'Duplicate record B.'));

  const response = await dispatchRoute({
    store,
    pathname: SUBSTRATE_MERGE_PATH,
    payload: {
      canonicalId: canonical.id,
      ids: [canonical.id, duplicateA.id, duplicateB.id],
    },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    ok: true,
    canonicalId: canonical.id,
    merged: [duplicateA.id, duplicateB.id],
  });

  const retiredA = await store.readRecord(duplicateA.id);
  const retiredB = await store.readRecord(duplicateB.id);
  const survivor = await store.readRecord(canonical.id);
  const live = liveRecords(await store.listRecords('Exposure'));

  assert.equal(retiredA.supersededById, canonical.id);
  assert.equal(retiredB.supersededById, canonical.id);
  assert.equal(retiredA.validTo, '2026-07-03T09:00:00.000Z');
  assert.equal(retiredB.validTo, '2026-07-03T09:00:00.000Z');
  assert.equal(survivor.supersededById, null);
  assert.deepEqual(live.map((record) => record.id), [canonical.id]);
  assert.equal((await store.listRecords('Exposure')).length, 3);
});

test('unknown id and malformed body are rejected without throwing', async () => {
  const store = await freshStore();

  const unknown = await dispatchRoute({
    store,
    pathname: SUBSTRATE_REDACT_PATH,
    payload: { id: 'exp_000000000000000000000000' },
  });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.ok, false);
  assert.equal(unknown.body.error, 'unknown_id');

  const malformed = await dispatchRoute({
    store,
    pathname: SUBSTRATE_REDACT_PATH,
    rawBody: '{"id":',
  });
  assert.equal(malformed.status, 400);
  assert.deepEqual(malformed.body, { ok: false, error: 'invalid_json' });
});

test('non-loopback requests are rejected before reading the body', async () => {
  const store = await freshStore();
  const response = mockResponse();
  const request = new Readable({
    read() {
      throw new Error('body should not be read when loopback gate fails');
    },
  });
  request.method = 'POST';
  request.url = SUBSTRATE_REDACT_PATH;
  request.socket = {
    remoteAddress: '203.0.113.10',
    localAddress: '127.0.0.1',
  };

  await handleSubstrateEdit(request, response, {
    store,
    dataDir: store.dataDir,
    now: fixedNow,
  });

  assert.equal(response.statusCode, 403);
  assert.deepEqual(JSON.parse(response.body), { ok: false, error: 'loopback_required' });
});

async function dispatchRoute({ store, pathname, payload, rawBody }) {
  const response = mockResponse();
  const body = rawBody ?? JSON.stringify(payload ?? {});
  const request = Readable.from([Buffer.from(body, 'utf8')]);
  request.method = 'POST';
  request.url = pathname;
  request.socket = {
    remoteAddress: '127.0.0.1',
    localAddress: '127.0.0.1',
  };

  await handleSubstrateEdit(request, response, {
    store,
    dataDir: store.dataDir,
    now: fixedNow,
  });

  return {
    status: response.statusCode,
    body: JSON.parse(response.body),
  };
}

function mockResponse() {
  return {
    statusCode: null,
    headersSent: false,
    body: '',
    writeHead(statusCode) {
      this.statusCode = statusCode;
      this.headersSent = true;
    },
    end(body = '') {
      this.body += body;
    },
  };
}

function exposureInput(sourceId, statement) {
  return {
    type: 'observation',
    statement,
    sourceId: `note:${sourceId}`,
    eventAt: '2026-07-02T10:00:00.000Z',
    provenance: { surface: 'ios', lane: 'ambient' },
  };
}

function liveRecords(records) {
  return records.filter((record) => !record.validTo && !record.supersededById);
}

function liveSourceCount(records, surface) {
  return liveRecords(records).filter((record) => record.provenance?.surface === surface).length;
}

async function freshStore() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-substrate-edit-'));
  return createSubstrateStore({ dataDir, now: fixedNow });
}
