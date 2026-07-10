import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  createSubstrateStore,
  isPlainObject,
  optionalString,
} from '../../src/substrate.mjs';
import { iso } from '../run.mjs';

export const SUBSTRATE_CORRECT_PATH = '/api/substrate/correct';
export const SUBSTRATE_REDACT_PATH = '/api/substrate/redact';
export const SUBSTRATE_MERGE_PATH = '/api/substrate/merge';
export const MAX_SUBSTRATE_EDIT_BODY_BYTES = 128_000;

const SUBSTRATE_EDIT_PATHS = new Set([
  SUBSTRATE_CORRECT_PATH,
  SUBSTRATE_REDACT_PATH,
  SUBSTRATE_MERGE_PATH,
]);

const RECORD_ID_PATTERN = /^[a-z]+_[a-f0-9]{24}$/;

export function isSubstrateEditPath(pathname) {
  return SUBSTRATE_EDIT_PATHS.has(pathname);
}

export async function handleSubstrateEdit(request, response, ctx = {}) {
  try {
    const pathname = requestPathname(request, ctx);
    if (!isSubstrateEditPath(pathname)) return false;

    if ((ctx.method ?? request.method) !== 'POST') {
      sendJson(response, 405, { ok: false, error: 'method_not_allowed' });
      return true;
    }

    if (!isSameMachineRequest(request, ctx)) {
      sendJson(response, 403, { ok: false, error: 'loopback_required' });
      return true;
    }

    const payload = await readSubstrateEditBody(request);
    const store = ctx.store ?? createSubstrateStore({ dataDir: ctx.dataDir, now: ctx.now });

    if (pathname === SUBSTRATE_CORRECT_PATH) {
      sendJson(response, 200, await correctExposure(store, payload, ctx));
      return true;
    }

    if (pathname === SUBSTRATE_REDACT_PATH) {
      sendJson(response, 200, await redactRecord(store, payload, ctx));
      return true;
    }

    if (pathname === SUBSTRATE_MERGE_PATH) {
      sendJson(response, 200, await mergeRecords(store, payload, ctx));
      return true;
    }

    return false;
  } catch (error) {
    if (response.headersSent) {
      response.end();
      return true;
    }
    sendJson(response, error.statusCode ?? 500, {
      ok: false,
      error: error.expose ? error.code : 'server_error',
    });
    return true;
  }
}

async function correctExposure(store, payload, ctx) {
  if (!isPlainObject(payload)) throw httpError(400, 'invalid_body');

  const id = recordId(payload.id, 'id');
  const statement = optionalString(payload.statement);
  if (!statement) throw httpError(400, 'missing_statement');

  const oldRecord = await liveRecordById(store, id);
  if (oldRecord.kind !== 'Exposure') throw httpError(400, 'unsupported_record_kind');

  const at = iso(ctx.now ?? new Date());
  let result;
  try {
    result = await store.supersedeExposure(
      oldRecord.id,
      correctedExposureInput(oldRecord, payload, statement),
      { at },
    );
  } catch {
    throw httpError(400, 'invalid_correction');
  }

  if (result.newRecord?.id === oldRecord.id) {
    try {
      result = await store.supersedeExposure(
        oldRecord.id,
        correctedExposureInput(oldRecord, payload, statement, {
          sourceId: curationSourceId('correct', oldRecord.id),
        }),
        { at },
      );
    } catch {
      throw httpError(400, 'invalid_correction');
    }
  }

  if (!result.newRecord || result.newRecord.id === oldRecord.id) {
    throw httpError(400, 'invalid_correction');
  }

  return { ok: true, id: result.newRecord.id, supersededId: oldRecord.id };
}

async function redactRecord(store, payload, ctx) {
  if (!isPlainObject(payload)) throw httpError(400, 'invalid_body');

  const id = recordId(payload.id, 'id');
  const oldRecord = await liveRecordById(store, id);
  if (oldRecord.kind !== 'Exposure') throw httpError(400, 'unsupported_record_kind');

  const at = iso(ctx.now ?? new Date());
  let result;
  try {
    result = await store.supersedeExposure(
      oldRecord.id,
      tombstoneExposureInput(oldRecord),
      { at },
    );
  } catch {
    throw httpError(400, 'invalid_redaction');
  }

  const tombstone = result.newRecord;
  if (!tombstone || tombstone.id === oldRecord.id) {
    throw httpError(400, 'invalid_redaction');
  }

  await writeExistingRecord(store, {
    ...tombstone,
    validTo: at,
    redacted: true,
    tombstone: true,
    frontierExcluded: true,
    metadata: {
      curation: {
        action: 'redact',
        redactedId: oldRecord.id,
      },
    },
  });

  return { ok: true, redacted: oldRecord.id };
}

async function mergeRecords(store, payload, ctx) {
  if (!isPlainObject(payload)) throw httpError(400, 'invalid_body');

  const canonicalId = recordId(payload.canonicalId, 'canonicalId');
  if (!Array.isArray(payload.ids)) throw httpError(400, 'invalid_ids');

  const ids = uniqueRecordIds(payload.ids, 'ids');
  const mergeIds = ids.filter((id) => id !== canonicalId);
  if (mergeIds.length === 0) throw httpError(400, 'invalid_merge');

  const canonical = await liveRecordById(store, canonicalId);
  const at = iso(ctx.now ?? new Date());

  for (const id of mergeIds) {
    const record = await liveRecordById(store, id);
    if (record.kind !== canonical.kind) throw httpError(400, 'record_kind_mismatch');
    await writeExistingRecord(store, {
      ...record,
      validTo: at,
      supersededById: canonical.id,
    });
  }

  return { ok: true, canonicalId: canonical.id, merged: mergeIds };
}

function correctedExposureInput(oldRecord, payload, statement, overrides = {}) {
  const hasContext = Object.hasOwn(payload, 'context');
  const metadata = isPlainObject(oldRecord.metadata) ? oldRecord.metadata : undefined;
  return {
    type: optionalString(oldRecord.type) ?? 'observation',
    statement,
    context: hasContext ? optionalString(payload.context) : optionalString(oldRecord.context),
    sourceId: optionalString(overrides.sourceId) ?? optionalString(oldRecord.sourceId),
    eventAt: optionalString(oldRecord.eventAt) ?? optionalString(oldRecord.validFrom),
    provenance: oldRecord.provenance,
    frontierExcluded: oldRecord.frontierExcluded === true,
    ...(metadata ? { metadata } : {}),
  };
}

function tombstoneExposureInput(oldRecord) {
  return {
    type: 'observation',
    statement: `TOMBSTONE redacted substrate record ${oldRecord.id}`,
    context: 'Redacted by founder curation.',
    sourceId: curationSourceId('redact', oldRecord.id),
    eventAt: optionalString(oldRecord.eventAt) ?? optionalString(oldRecord.validFrom),
    provenance: oldRecord.provenance,
    frontierExcluded: true,
    metadata: {
      curation: {
        action: 'redact',
        redactedId: oldRecord.id,
      },
    },
  };
}

function curationSourceId(action, id) {
  return `curation:${action}:${id}`;
}

async function liveRecordById(store, id) {
  const record = await store.readRecord(id);
  if (!record) throw httpError(400, 'unknown_id');
  if (record.validTo || record.supersededById) throw httpError(400, 'superseded_id');
  return record;
}

async function writeExistingRecord(store, record) {
  const file = await recordFileForId(store, record.id);
  if (!file) throw httpError(400, 'unknown_id');
  await fs.writeFile(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

async function recordFileForId(store, id) {
  const root = store.rootDir;
  if (!root) return null;
  return findRecordFile(root, `${id}.json`);
}

async function findRecordFile(dir, filename) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }

  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === filename) return file;
    if (entry.isDirectory()) {
      const found = await findRecordFile(file, filename);
      if (found) return found;
    }
  }
  return null;
}

async function readSubstrateEditBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_SUBSTRATE_EDIT_BODY_BYTES) {
      throw httpError(413, 'body_too_large');
    }
    chunks.push(buffer);
  }

  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) throw httpError(400, 'empty_json_body');
  try {
    return JSON.parse(raw);
  } catch {
    throw httpError(400, 'invalid_json');
  }
}

function uniqueRecordIds(values, label) {
  const ids = values.map((value) => recordId(value, label));
  return [...new Set(ids)];
}

function recordId(value, label) {
  const id = optionalString(value);
  if (!id) throw httpError(400, `missing_${label}`);
  if (!RECORD_ID_PATTERN.test(id)) throw httpError(400, `invalid_${label}`);
  return id;
}

function requestPathname(request, ctx) {
  const pathname = optionalString(ctx.pathname ?? ctx.path);
  if (pathname) return pathname;
  return new URL(request.url ?? '/', 'http://localhost').pathname;
}

function isSameMachineRequest(request, ctx) {
  const gate = ctx.isSameMachine ?? ctx.isLoopbackRequest;
  if (typeof gate === 'function') return gate(request) === true;

  const remote = optionalString(request?.socket?.remoteAddress) ?? '';
  if (remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1') return true;

  const local = optionalString(request?.socket?.localAddress) ?? '';
  return Boolean(remote) && remote === local;
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  response.end(`${JSON.stringify(body)}\n`);
}

function httpError(statusCode, code) {
  const error = new Error(code);
  error.statusCode = statusCode;
  error.code = code;
  error.expose = true;
  return error;
}
