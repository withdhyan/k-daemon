import { promises as fs } from 'node:fs';
import path from 'node:path';

import { safeDataPath } from '../../daemon/run.mjs';
import { optionalString, requiredString } from '../substrate.mjs';

export const NOTES_DIR = 'notes';
export const NOTES_FILE = 'NOTES.md';
export const NOTES_MAX_CHARS = 24 * 1024;
export const NOTES_ENTRY_DELIMITER = '\n\n§\n\n';

const DEFAULT_DATA_DIR = path.join(process.cwd(), 'data');
const INJECTION_PATTERNS = Object.freeze([
  Object.freeze({
    code: 'ignore_previous_instructions',
    pattern: /ignore\s+previous\s+instructions/i,
  }),
  Object.freeze({
    code: 'role_marker',
    pattern: /(^|\n)\s*(?:system|developer|user|assistant|tool)\s*:/i,
  }),
  Object.freeze({
    code: 'role_marker_tag',
    pattern: /<\/?\s*(?:system|developer|user|assistant|tool)\s*>/i,
  }),
  Object.freeze({
    code: 'tool_call_syntax',
    pattern: /<\s*tool_call\s*>|<\/\s*tool_call\s*>|"tool_calls"\s*:|"function_call"\s*:/i,
  }),
]);

export async function addNote(noteText, options = {}) {
  const entry = normalizeEntry(noteText);
  const entries = await readNoteEntries(options);
  const next = [...entries, entry];
  await writeNoteEntries(next, options);
  return Object.freeze({ ok: true, action: 'add', entries: Object.freeze(next) });
}

export async function replaceNote(match, replacement, options = {}) {
  const needle = requiredString(match, 'note match');
  const nextEntry = normalizeEntry(replacement);
  const entries = await readNoteEntries(options);
  const index = entries.findIndex((entry) => entry.includes(needle));
  if (index === -1) return Object.freeze({ ok: false, action: 'replace', reason: 'note_not_found' });

  const next = [...entries];
  next[index] = nextEntry;
  await writeNoteEntries(next, options);
  return Object.freeze({ ok: true, action: 'replace', entries: Object.freeze(next) });
}

export async function removeNote(match, options = {}) {
  const needle = requiredString(match, 'note match');
  const entries = await readNoteEntries(options);
  const index = entries.findIndex((entry) => entry.includes(needle));
  if (index === -1) return Object.freeze({ ok: false, action: 'remove', reason: 'note_not_found' });

  const next = entries.filter((_, currentIndex) => currentIndex !== index);
  await writeNoteEntries(next, options);
  return Object.freeze({ ok: true, action: 'remove', entries: Object.freeze(next) });
}

export async function readNoteEntries(options = {}) {
  const text = await readNotesFile(options);
  return Object.freeze(parseNoteEntries(text));
}

export async function loadNotesSnapshot(options = {}) {
  const logger = options.logger ?? console;
  const entries = await readNoteEntries(options);
  const accepted = [];
  const excluded = [];

  for (const entry of entries) {
    const hit = injectionScan(entry);
    if (hit) {
      excluded.push(Object.freeze({ reason: hit.code, excerpt: excerpt(entry) }));
      logger?.warn?.(`[cs-k] notes: excluded note from prompt snapshot (${hit.code})`);
      continue;
    }

    const projectedBlock = formatNotesBlock([...accepted, entry]);
    if (projectedBlock.length > NOTES_MAX_CHARS) {
      excluded.push(Object.freeze({ reason: 'snapshot_char_bound', excerpt: excerpt(entry) }));
      logger?.warn?.('[cs-k] notes: excluded note from prompt snapshot (snapshot_char_bound)');
      continue;
    }

    accepted.push(entry);
  }

  const block = formatNotesBlock(accepted);
  return deepFreeze({
    kind: 'NotesSnapshot',
    schemaVersion: 1,
    maxChars: NOTES_MAX_CHARS,
    entries: Object.freeze([...accepted]),
    block,
    excluded: Object.freeze(excluded),
  });
}

export function formatNotesBlock(entries) {
  const list = Array.isArray(entries) ? entries.map(normalizeEntry).filter(Boolean) : [];
  if (list.length === 0) return '';
  return [
    '## K operational notes',
    'These are founder-approved operational notes for this agent turn.',
    list.map((entry) => `§\n${entry}`).join('\n\n'),
  ].join('\n');
}

export function parseNoteEntries(text) {
  const raw = typeof text === 'string' ? text : '';
  return raw
    .split(/\n\s*§\s*\n/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function notesFilePath(dataDir) {
  return safeDataPath(resolveDataDir(dataDir), path.join(NOTES_DIR, NOTES_FILE));
}

async function readNotesFile(options = {}) {
  try {
    return await fs.readFile(notesFilePath(options.dataDir), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

async function writeNoteEntries(entries, options = {}) {
  const normalized = entries.map(normalizeEntry);
  const body = serializeNoteEntries(normalized);
  if (body.length > NOTES_MAX_CHARS) {
    throw new Error(`notes store exceeds ${NOTES_MAX_CHARS} chars`);
  }

  const file = notesFilePath(options.dataDir);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, body, 'utf8');
}

function serializeNoteEntries(entries) {
  if (entries.length === 0) return '';
  return `${entries.join(NOTES_ENTRY_DELIMITER)}\n`;
}

function normalizeEntry(value) {
  const entry = requiredString(value, 'note text');
  if (/^\s*§\s*$/m.test(entry)) {
    throw new Error('note text may not contain the entry delimiter');
  }
  return entry;
}

function injectionScan(entry) {
  return INJECTION_PATTERNS.find(({ pattern }) => pattern.test(entry)) ?? null;
}

function excerpt(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
}

function resolveDataDir(dataDir) {
  // REQUIRED, never defaulted: a silent fallback to the real data/ dir let a
  // test with an undefined dataDir write into the founder's live NOTES.md.
  if (typeof dataDir !== 'string' || dataDir.trim().length === 0) {
    throw new Error('notes: dataDir is required');
  }
  return dataDir;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}
