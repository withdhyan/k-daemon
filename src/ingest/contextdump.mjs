import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { safeDataPath } from '../../daemon/run.mjs';
import {
  createSubstrateStore,
  optionalString,
  requiredString,
} from '../substrate.mjs';
import {
  ingestWire,
  walkIngestDir,
} from './wire.mjs';
import { noteLeadStatement } from './notes.mjs';

export const CONTEXTDUMP_SURFACE = 'contextdump';
export const CONTEXTDUMP_DIR = path.join(os.homedir(), 'ai', 'context dump');
export const CONTEXTDUMP_NO_EXPORT_MESSAGE =
  `ingest-contextdump: no context dump found at ${CONTEXTDUMP_DIR} - pass a directory or create ${CONTEXTDUMP_DIR}`;

export async function ingestContextdump(options = {}) {
  const store = options.store ?? createSubstrateStore(options.storeOptions);
  const dir = safeExternalPath(options.dir ?? options.path ?? CONTEXTDUMP_DIR, 'contextdump directory');

  if (!await directoryExists(dir)) {
    return skippedResult(store, { dir });
  }

  const records = await contextdumpExposureRecords({ dir });
  const result = await ingestWire(records, CONTEXTDUMP_SURFACE, { ...options, store });
  return {
    ...result,
    dir,
    skipped: false,
  };
}

export async function contextdumpExposureRecords({ dir = CONTEXTDUMP_DIR } = {}) {
  const root = safeExternalPath(dir, 'contextdump directory');
  // Telegram HTML export ingest deferred to follow-up.
  const files = (await walkIngestDir(
    root,
    (file) => path.extname(file).toLowerCase() === '.md',
    { maxDepth: 1 },
  )).sort((a, b) => a.localeCompare(b));
  const records = [];

  for (const file of files) {
    const record = await contextdumpFileToExposure(file, { root });
    if (record) records.push(record);
  }

  return records;
}

async function contextdumpFileToExposure(file, { root = path.dirname(file) } = {}) {
  const resolvedFile = safeExternalPath(file, 'contextdump file');
  const buffer = await fs.readFile(resolvedFile);
  if (isBinaryBuffer(buffer)) return null;

  const text = stripByteOrderMark(buffer.toString('utf8'));
  const statement = noteLeadStatement(text);
  if (!statement) return null;

  const stat = await fs.stat(resolvedFile);
  const relativePath = normalizeRelativePath(path.relative(root, resolvedFile)) ||
    path.basename(resolvedFile);
  const contentHash = contentSha256(buffer);

  return {
    type: 'reference',
    statement,
    sourceId: [
      CONTEXTDUMP_SURFACE,
      relativePath,
      contentHash,
    ].join(':'),
    eventAt: stat.mtime.toISOString(),
    context: path.basename(resolvedFile),
    provenance: { surface: CONTEXTDUMP_SURFACE, lane: 'deliberate' },
    frontierExcluded: true,
    metadata: {
      path: relativePath,
      contentHash,
      byteLength: buffer.length,
    },
  };
}

function isBinaryBuffer(buffer) {
  if (!Buffer.isBuffer(buffer)) return false;
  if (buffer.length === 0) return false;
  if (buffer.includes(0)) return true;

  const sampleLength = Math.min(buffer.length, 4096);
  let controlCount = 0;
  for (let index = 0; index < sampleLength; index += 1) {
    const byte = buffer[index];
    const allowedWhitespace = byte === 9 || byte === 10 || byte === 13;
    if (byte < 32 && !allowedWhitespace) controlCount += 1;
  }
  return controlCount / sampleLength > 0.1;
}

function contentSha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function stripByteOrderMark(value) {
  return String(value ?? '').replace(/^\uFEFF/, '');
}

function normalizeRelativePath(value) {
  return optionalString(String(value ?? '').split(path.sep).join('/'));
}

async function directoryExists(dir) {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function safeExternalPath(value, label) {
  const resolved = path.resolve(requiredString(value, label));
  const rel = path.relative('/', resolved);
  if (!rel) throw new Error(`refused unsafe data path: ${value}`);
  return safeDataPath('/', rel);
}

function skippedResult(store, { dir }) {
  return {
    store,
    dir,
    skipped: true,
    message: CONTEXTDUMP_NO_EXPORT_MESSAGE,
    surface: CONTEXTDUMP_SURFACE,
    exposures: [],
    createdCount: 0,
    duplicateCount: 0,
  };
}
