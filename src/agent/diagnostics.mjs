import { promises as fs } from 'node:fs';
import path from 'node:path';

import { iso, safeDataPath } from '../../daemon/run.mjs';

export const DIAGNOSTICS_DIR = 'diagnostics';
export const DIAGNOSTICS_LOG = 'k-diagnostics.log';
export const DIAGNOSTICS_MAX_BYTES = 5 * 1024 * 1024;

export async function appendDiagnostic({ dataDir, turn } = {}) {
  try {
    const input = turn && typeof turn === 'object' ? { ...turn } : {};
    if (!input.dataDir && dataDir) input.dataDir = dataDir;
    await appendDiagnosticLine(input);
  } catch {
    // Diagnostics are observability only. They must never affect the turn path.
  }
}

export async function readRecentDiagnostics({ dataDir, limit = 100 } = {}) {
  const cappedLimit = boundedLimit(limit);
  if (cappedLimit === 0) return [];

  const file = diagnosticLogPath(dataDir);
  const lines = [];
  for (const candidate of [`${file}.1`, file]) {
    const text = await readOptionalText(candidate);
    if (!text) continue;
    lines.push(...text.split('\n').filter(Boolean));
  }

  const records = [];
  for (const line of lines.slice(-cappedLimit * 2)) {
    try {
      records.push(JSON.parse(line));
    } catch {
      // Keep reading around a corrupt/truncated line.
    }
  }
  return records.slice(-cappedLimit);
}

async function appendDiagnosticLine(turn) {
  const dataDir = turn?.dataDir;
  if (!dataDir) return;

  const dir = safeDataPath(dataDir, DIAGNOSTICS_DIR);
  await fs.mkdir(dir, { recursive: true });

  const line = `${JSON.stringify(projectDiagnosticTurn(turn))}\n`;
  const file = path.join(dir, DIAGNOSTICS_LOG);
  await rotateIfNeeded(file, Buffer.byteLength(line, 'utf8'));
  await fs.appendFile(file, line, { encoding: 'utf8', flag: 'a' });
}

function projectDiagnosticTurn(turn) {
  const record = {
    ts: diagnosticTimestamp(turn),
    lane: stringValue(turn?.lane, 'unknown'),
    sensitivity: stringValue(turn?.sensitivity, 'unknown'),
    sovereign: turn?.sovereign === true,
    steps: integerValue(turn?.steps, 0),
    held: heldCount(turn?.held),
    ttftMs: durationMs(turn?.ttftMs),
    totalMs: durationMs(turn?.totalMs),
    ok: turn?.ok === true,
  };

  const glazeScore = finiteNumber(turn?.glazeScore ?? turn?.glaze?.score);
  if (glazeScore !== undefined) record.glazeScore = glazeScore;
  const errorCode = optionalString(turn?.errorCode);
  if (errorCode) record.errorCode = errorCode;

  return record;
}

async function rotateIfNeeded(file, nextBytes) {
  const stats = await optionalStat(file);
  if (!stats || stats.size + nextBytes <= DIAGNOSTICS_MAX_BYTES) return;

  await fs.rm(`${file}.1`, { force: true }).catch(() => {});
  try {
    await fs.rename(file, `${file}.1`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function diagnosticLogPath(dataDir) {
  return path.join(safeDataPath(dataDir, DIAGNOSTICS_DIR), DIAGNOSTICS_LOG);
}

async function optionalStat(file) {
  try {
    return await fs.stat(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function readOptionalText(file) {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
}

function diagnosticTimestamp(turn) {
  const explicit = optionalString(turn?.ts);
  if (explicit) return explicit;
  try {
    return iso(turn?.now ?? new Date());
  } catch {
    return new Date().toISOString();
  }
}

function boundedLimit(value) {
  const number = Number(value ?? 100);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.min(Math.floor(number), 1000);
}

function stringValue(value, fallback) {
  return optionalString(value) ?? fallback;
}

function optionalString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function integerValue(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

function heldCount(value) {
  if (Array.isArray(value)) return value.length;
  return integerValue(value, 0);
}

function durationMs(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : null;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}
