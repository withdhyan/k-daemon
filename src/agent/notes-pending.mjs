import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { safeDataPath } from '../../daemon/run.mjs';
import { isPlainObject, optionalString, requiredString } from '../substrate.mjs';
import { addNote, removeNote, replaceNote } from './notes.mjs';

export const PENDING_NOTES_DIR = path.join('pending', 'notes');
export const PENDING_NOTE_STATUSES = Object.freeze(['pending', 'approved', 'rejected']);
export const PENDING_NOTES_LIST_PATH = '/api/notes/pending';
export const PENDING_NOTES_DECISION_PATH = '/api/notes/pending/decision';

const DEFAULT_DATA_DIR = path.join(process.cwd(), 'data');
const NOTE_PROPOSAL_ID_PATTERN = /^note-[a-f0-9]{24}$/;

export function isPendingNotesPath(pathname) {
  return (
    pathname === PENDING_NOTES_LIST_PATH ||
    pathname === PENDING_NOTES_DECISION_PATH ||
    pathname.startsWith(`${PENDING_NOTES_LIST_PATH}/`)
  );
}

export async function handlePendingNotesRoute(request, response, context, deps) {
  const { method, pathname } = context;
  const { sendJson, httpError, readPlaintextJson } = deps;

  if (method === 'GET' && pathname === PENDING_NOTES_LIST_PATH) {
    sendJson(response, 200, await listPendingNoteProposals({ dataDir: context.dataDir }));
    return true;
  }

  if (method === 'GET' && pathname.startsWith(`${PENDING_NOTES_LIST_PATH}/`)) {
    const proposalId = pathname.slice(`${PENDING_NOTES_LIST_PATH}/`.length);
    const record = await readPendingNoteProposal(proposalId, { dataDir: context.dataDir }).catch(() => null);
    if (!record) throw httpError(404, 'pending_note_not_found');
    sendJson(response, 200, projectPendingNote(record));
    return true;
  }

  if (method === 'POST' && pathname === PENDING_NOTES_DECISION_PATH) {
    if (typeof deps.isSameMachine === 'function' && !deps.isSameMachine(request)) {
      sendJson(response, 403, { ok: false, error: 'loopback_required' });
      return true;
    }
    const payload = await readPlaintextJson(request);
    sendJson(response, 200, await decidePendingNoteProposal(payload, {
      dataDir: context.dataDir,
      now: context.now,
      httpError,
    }));
    return true;
  }

  if (isPendingNotesPath(pathname)) {
    sendJson(response, 405, { ok: false, error: 'method_not_allowed' });
    return true;
  }

  return false;
}

export async function stagePendingNoteProposal(input, options = {}) {
  const proposal = normalizePendingNoteProposal(input, options);
  const file = pendingNoteFile(proposal.proposalId, options);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(proposal, null, 2)}\n`, 'utf8');
  return Object.freeze({
    record: proposal,
    outcome: 'created',
    pendingPath: pendingNoteRelPath(proposal.proposalId),
  });
}

export async function listPendingNoteProposals(options = {}) {
  const records = await readPendingNoteRecords(options);
  const live = records.filter((record) => record.status === 'pending');
  return Object.freeze({
    notes: Object.freeze(records.map(projectPendingNote)),
    pendingCount: live.length,
  });
}

export async function readPendingNoteProposal(proposalId, options = {}) {
  return readJsonIfPresent(pendingNoteFile(proposalId, options));
}

export async function approvePendingNoteProposal(proposalId, options = {}) {
  const record = await readPendingNoteProposal(proposalId, options);
  if (!record) return null;
  if (record.status !== 'pending') return Object.freeze({ record, changed: false, applied: false });

  const applied = await applyPendingNotePayload(record.payload, options);
  if (!applied.ok) return Object.freeze({ record, changed: false, applied: false, reason: applied.reason });

  const updated = {
    ...record,
    status: 'approved',
    decidedAt: iso(options.now),
    decisionNote: optionalString(options.note) ?? record.decisionNote ?? '',
  };
  await writePendingNoteRecord(updated, options);
  return Object.freeze({ record: updated, changed: true, applied: true });
}

export async function rejectPendingNoteProposal(proposalId, options = {}) {
  const record = await readPendingNoteProposal(proposalId, options);
  if (!record) return null;
  if (record.status !== 'pending') return Object.freeze({ record, changed: false });

  const updated = {
    ...record,
    status: 'rejected',
    decidedAt: iso(options.now),
    decisionNote: optionalString(options.note) ?? record.decisionNote ?? '',
  };
  await writePendingNoteRecord(updated, options);
  return Object.freeze({ record: updated, changed: true });
}

async function decidePendingNoteProposal(payload, { dataDir, now, httpError }) {
  if (!isPlainObject(payload)) throw httpError(400, 'invalid_decision_payload');
  rejectClientPathFields(payload, httpError);

  const proposalId = optionalString(payload.proposalId ?? payload.noteId);
  if (!proposalId) throw httpError(400, 'missing_proposalId');

  const decision = optionalString(payload.decision);
  if (decision !== 'approve' && decision !== 'reject') throw httpError(400, 'invalid_decision');

  let result;
  try {
    result = decision === 'approve'
      ? await approvePendingNoteProposal(proposalId, { dataDir, now, note: payload.note })
      : await rejectPendingNoteProposal(proposalId, { dataDir, now, note: payload.note });
  } catch {
    throw httpError(400, 'invalid_proposalId');
  }

  if (!result) throw httpError(404, 'pending_note_not_found');
  if (result.reason) throw httpError(409, result.reason);

  return {
    ok: true,
    proposalId,
    status: result.record.status,
    applied: result.applied === true,
  };
}

async function applyPendingNotePayload(payload, options) {
  if (!isPlainObject(payload)) return { ok: false, reason: 'invalid_note_payload' };
  const action = optionalString(payload.action);
  if (action === 'add') {
    return addNote(requiredString(payload.text, 'note text'), options);
  }
  if (action === 'replace') {
    return replaceNote(
      requiredString(payload.existingText ?? payload.match, 'existing note text'),
      requiredString(payload.replacement ?? payload.text, 'replacement note text'),
      options,
    );
  }
  if (action === 'remove') {
    return removeNote(requiredString(payload.existingText ?? payload.match, 'existing note text'), options);
  }
  return { ok: false, reason: 'unsupported_note_action' };
}

function normalizePendingNoteProposal(input, options) {
  if (!isPlainObject(input)) throw new Error('pending note proposal must be an object');
  const payload = normalizePayload(input.payload);
  const evidence = stringList(input.evidence);
  const basis = {
    origin: optionalString(input.origin) ?? 'self_review',
    action: payload.action,
    payload,
    evidence,
  };
  const proposalId = optionalString(input.proposalId) ?? noteProposalIdFor(basis);
  assertProposalId(proposalId);
  return Object.freeze({
    kind: 'PendingNoteProposal',
    schemaVersion: 1,
    origin: basis.origin,
    proposalId,
    status: 'pending',
    stagedAt: iso(options.now),
    payload,
    gist: optionalString(input.gist) ?? gistForPayload(payload),
    diffPreview: optionalString(input.diffPreview) ?? diffPreviewForPayload(payload),
    evidence: Object.freeze(evidence),
  });
}

function normalizePayload(value) {
  if (!isPlainObject(value)) throw new Error('pending note payload must be an object');
  const action = normalizeAction(value.action);
  if (action === 'add') {
    return Object.freeze({ action, text: requiredString(value.text, 'note text') });
  }
  if (action === 'replace') {
    return Object.freeze({
      action,
      existingText: requiredString(value.existingText ?? value.match, 'existing note text'),
      replacement: requiredString(value.replacement ?? value.text, 'replacement note text'),
    });
  }
  return Object.freeze({
    action,
    existingText: requiredString(value.existingText ?? value.match, 'existing note text'),
  });
}

function normalizeAction(value) {
  const action = optionalString(value);
  if (action === 'add' || action === 'create') return 'add';
  if (action === 'replace' || action === 'update' || action === 'edit') return 'replace';
  if (action === 'remove' || action === 'delete') return 'remove';
  throw new Error(`unsupported pending note action: ${value}`);
}

function projectPendingNote(record) {
  return {
    proposalId: record.proposalId,
    status: record.status,
    origin: record.origin,
    action: record.payload?.action,
    gist: record.gist,
    diffPreview: record.diffPreview,
    evidence: Array.isArray(record.evidence) ? record.evidence : [],
    stagedAt: record.stagedAt,
    decidedAt: record.decidedAt,
    decisionNote: record.decisionNote,
  };
}

async function readPendingNoteRecords(options) {
  let entries = [];
  try {
    entries = await fs.readdir(pendingNotesDir(options), { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  const records = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const record = await readJsonIfPresent(path.join(pendingNotesDir(options), entry.name));
    if (record) records.push(record);
  }

  return records.sort((a, b) =>
    String(a.stagedAt ?? '').localeCompare(String(b.stagedAt ?? '')) ||
    String(a.proposalId ?? '').localeCompare(String(b.proposalId ?? '')));
}

async function writePendingNoteRecord(record, options) {
  const file = pendingNoteFile(record.proposalId, options);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

async function readJsonIfPresent(file) {
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function pendingNotesDir(options = {}) {
  return safeDataPath(resolveDataDir(options.dataDir), PENDING_NOTES_DIR);
}

function pendingNoteFile(proposalId, options = {}) {
  assertProposalId(proposalId);
  return safeDataPath(resolveDataDir(options.dataDir), pendingNoteRelPath(proposalId));
}

function pendingNoteRelPath(proposalId) {
  return path.join(PENDING_NOTES_DIR, `${proposalId}.json`);
}

function noteProposalIdFor(value) {
  return `note-${sha256(JSON.stringify(value)).slice(0, 24)}`;
}

function gistForPayload(payload) {
  if (payload.action === 'add') return firstLine(payload.text);
  if (payload.action === 'replace') return `Replace note: ${firstLine(payload.existingText)}`;
  return `Remove note: ${firstLine(payload.existingText)}`;
}

function diffPreviewForPayload(payload) {
  if (payload.action === 'add') return `+${payload.text}`;
  if (payload.action === 'replace') return `-${payload.existingText}\n+${payload.replacement}`;
  return `-${payload.existingText}`;
}

function firstLine(value) {
  return requiredString(value, 'text').split(/\r?\n/)[0].slice(0, 160);
}

function stringList(value) {
  if (!Array.isArray(value)) {
    const text = optionalString(value);
    return text ? [text] : [];
  }
  return value.map((item) => optionalString(item?.excerpt ?? item)).filter(Boolean);
}

function rejectClientPathFields(payload, httpError) {
  for (const field of ['path', 'file', 'relPath', 'targetPath', 'notePath']) {
    if (Object.hasOwn(payload, field)) throw httpError(400, 'client_path_not_allowed');
  }
}

function assertProposalId(value) {
  const id = requiredString(value, 'proposalId');
  if (!NOTE_PROPOSAL_ID_PATTERN.test(id)) throw new Error(`invalid proposalId: ${id}`);
  return id;
}

function resolveDataDir(dataDir) {
  return path.resolve(optionalString(dataDir) ?? process.env.CS_K_DATA_DIR ?? DEFAULT_DATA_DIR);
}

function iso(now) {
  const fn = typeof now === 'function' ? now : () => new Date();
  return fn().toISOString();
}

function sha256(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}
