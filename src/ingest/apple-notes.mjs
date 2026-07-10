import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

import { safeDataPath } from '../../daemon/run.mjs';
import {
  createSubstrateStore,
  optionalString,
  requiredString,
} from '../substrate.mjs';
import { ingestWire } from './wire.mjs';
import { noteLeadStatement } from './notes.mjs';

export const APPLE_NOTES_SURFACE = 'apple-notes';
export const APPLE_NOTES_DB_PATH = path.join(
  os.homedir(),
  'Library',
  'Group Containers',
  'group.com.apple.notes',
  'NoteStore.sqlite',
);
export const APPLE_NOTES_SQLITE3_PATH = '/usr/bin/sqlite3';
export const APPLE_NOTES_OSASCRIPT_PATH = '/usr/bin/osascript';
export const APPLE_NOTES_NO_DB_MESSAGE =
  `ingest-apple-notes: no Apple Notes database found at ${APPLE_NOTES_DB_PATH} - grant Full Disk Access or pass a dbPath`;

const execFileAsync = promisify(execFile);
const SQLITE_SEPARATOR = '\t';
const SQLITE_MAX_BUFFER = 128 * 1024 * 1024;
const APPLESCRIPT_MAX_BUFFER = 64 * 1024 * 1024;
// Bulk-array JXA (one Apple event per property per folder) measured ~300ms for
// 680 notes / 11.7MB of plaintext; per-note property access measured ~7s PER
// NOTE. The chunk size is a reply-size guard (AppleEvent -1741 on huge replies),
// not a latency knob — one chunk normally covers the whole corpus.
const APPLESCRIPT_CHUNK_SIZE = 2000;
const APPLESCRIPT_TIMEOUT_MS = 60_000;
const APPLESCRIPT_TOTAL_TIMEOUT_MS = 300_000;
const CORE_DATA_EPOCH_OFFSET_SECONDS = 978307200;
const RECENTLY_DELETED_FOLDER = 'recently deleted';
const APPLESCRIPT_COUNT_NOTES_SCRIPT = `
function run() {
  return String(Application('Notes').notes.id().length);
}
`;
// Bulk-array extraction: each property is fetched for a whole folder in ONE
// Apple event (notes.id() / .name() / .plaintext() / dates). plaintext instead
// of body: body() is HTML, blows the AppleEvent reply limit (-1741) on large
// corpora, and would need stripping; plaintext is what the substrate stores.
const APPLESCRIPT_NOTE_CHUNK_SCRIPT = `
function run(argv) {
  const start = Math.max(0, parseInt(argv[0], 10) || 0);
  const limit = Math.max(1, parseInt(argv[1], 10) || 1);
  const end = start + limit;
  const folders = Application('Notes').folders();
  const records = [];
  let position = 0;

  for (let f = 0; f < folders.length && position < end; f += 1) {
    const folder = folders[f];
    const folderName = safeString(() => folder.name());
    const collection = folder.notes;
    const ids = collection.id();
    if (position + ids.length <= start) {
      position += ids.length;
      continue;
    }
    const names = collection.name();
    const texts = collection.plaintext();
    const created = collection.creationDate();
    const modified = collection.modificationDate();

    for (let i = 0; i < ids.length; i += 1, position += 1) {
      if (position < start || position >= end) continue;
      records.push({
        id: safeString(() => ids[i]),
        name: safeString(() => names[i]),
        plaintext: safeString(() => texts[i]),
        creationDate: isoDate(created[i]),
        modificationDate: isoDate(modified[i]),
        folder: folderName,
      });
    }
  }

  return JSON.stringify(records);
}

function safeString(get) {
  try {
    const raw = typeof get === 'function' ? get() : get;
    if (raw === undefined || raw === null) return '';
    return String(raw);
  } catch (error) {
    return '';
  }
}

function isoDate(value) {
  try {
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
    if (value === undefined || value === null) return '';
    return String(value);
  } catch (error) {
    return '';
  }
}
`;

export async function ingestAppleNotes(options = {}) {
  const store = options.store ?? createSubstrateStore(options.storeOptions);
  const dbPath = safeExternalPath(options.dbPath ?? options.path ?? APPLE_NOTES_DB_PATH, 'Apple Notes database');
  const sqlite3Path = options.sqlite3Path ?? APPLE_NOTES_SQLITE3_PATH;
  const recordsOrSkip = await appleNotesExposureRecords({
    dbPath,
    sqlite3Path,
    execFileImpl: options.execFileImpl,
    fileExistsImpl: options.fileExistsImpl,
    logger: options.logger,
    osascriptExecFile: options.osascriptExecFile,
    osascriptPath: options.osascriptPath,
    appleScriptChunkSize: options.appleScriptChunkSize,
    appleScriptTimeoutMs: options.appleScriptTimeoutMs,
    appleScriptTotalTimeoutMs: options.appleScriptTotalTimeoutMs,
  });

  if (isSkippedResult(recordsOrSkip)) {
    return {
      ...recordsOrSkip,
      store,
    };
  }

  const result = await ingestWire(recordsOrSkip, APPLE_NOTES_SURFACE, { ...options, store });
  return {
    ...result,
    path: dbPath,
    skipped: false,
  };
}

export async function appleNotesExposureRecords({
  dbPath = APPLE_NOTES_DB_PATH,
  sqlite3Path = APPLE_NOTES_SQLITE3_PATH,
  execFileImpl = execFileAsync,
  fileExistsImpl = fileExists,
  logger = console,
  osascriptExecFile = execFileAsync,
  osascriptPath = APPLE_NOTES_OSASCRIPT_PATH,
  appleScriptChunkSize = APPLESCRIPT_CHUNK_SIZE,
  appleScriptTimeoutMs = APPLESCRIPT_TIMEOUT_MS,
  appleScriptTotalTimeoutMs = APPLESCRIPT_TOTAL_TIMEOUT_MS,
} = {}) {
  const resolvedDbPath = safeExternalPath(dbPath, 'Apple Notes database');
  const appleScriptOptions = {
    execFileImpl: osascriptExecFile,
    logger,
    osascriptPath,
    chunkSize: appleScriptChunkSize,
    timeoutMs: appleScriptTimeoutMs,
    totalTimeoutMs: appleScriptTotalTimeoutMs,
  };

  try {
    if (!await fileExistsImpl(resolvedDbPath)) {
      return skippedResult(undefined, {
        path: resolvedDbPath,
        reason: 'missing-db',
        message: APPLE_NOTES_NO_DB_MESSAGE,
      });
    }
  } catch (error) {
    if (isPermissionError(error)) {
      return appleNotesExposureRecordsFromAppleScript(appleScriptOptions, {
        path: resolvedDbPath,
      });
    }
    throw error;
  }

  let rows;
  try {
    rows = await queryAppleNotesRows(resolvedDbPath, sqlite3Path, { execFileImpl });
  } catch (error) {
    if (isPermissionError(error)) {
      return appleNotesExposureRecordsFromAppleScript(appleScriptOptions, {
        path: resolvedDbPath,
      });
    }
    throw error;
  }

  const records = [];
  for (const row of rows) {
    const record = appleNoteRowToExposure(row);
    if (record) records.push(record);
  }
  return records;
}

export async function appleNotesExposureRecordsFromAppleScript(options = {}, context = {}) {
  const logger = options.logger ?? console;
  const chunkSize = positiveInteger(options.chunkSize, APPLESCRIPT_CHUNK_SIZE);
  const timeoutMs = positiveInteger(options.timeoutMs, APPLESCRIPT_TIMEOUT_MS);
  const totalTimeoutMs = positiveInteger(options.totalTimeoutMs, APPLESCRIPT_TOTAL_TIMEOUT_MS);
  const deadline = Date.now() + totalTimeoutMs;

  try {
    const initialTimeoutMs = remainingTimeout(deadline, timeoutMs);
    if (initialTimeoutMs <= 0) {
      throw new Error(`AppleScript Notes extraction timed out after ${totalTimeoutMs}ms`);
    }

    const count = await appleScriptNoteCount({ ...options, timeoutMs: initialTimeoutMs });
    const records = [];

    for (let offset = 0; offset < count; offset += chunkSize) {
      const remainingMs = remainingTimeout(deadline, timeoutMs);
      if (remainingMs <= 0) {
        throw new Error(`AppleScript Notes extraction timed out after ${totalTimeoutMs}ms`);
      }

      const notes = await appleScriptNoteChunk(offset, chunkSize, {
        ...options,
        timeoutMs: remainingMs,
      });
      for (const note of notes) {
        const record = appleScriptNoteToExposure(note);
        if (record) records.push(record);
      }
    }

    return records;
  } catch (error) {
    logAppleScriptFallbackFailure(logger, error, context);
    return [];
  }
}

export function noteTextFromZdata(gzippedBuffer) {
  if (!Buffer.isBuffer(gzippedBuffer)) return undefined;
  if (gzippedBuffer.length < 2 || gzippedBuffer[0] !== 0x1f || gzippedBuffer[1] !== 0x8b) {
    return undefined;
  }

  try {
    return extractNoteText(gunzipSync(gzippedBuffer));
  } catch {
    return undefined;
  }
}

export function extractNoteText(gunzippedProtobufBuffer) {
  if (!Buffer.isBuffer(gunzippedProtobufBuffer)) return undefined;

  try {
    const document = firstLengthDelimitedField(gunzippedProtobufBuffer, 2);
    const note = document ? firstLengthDelimitedField(document, 3) : undefined;
    const noteText = note ? firstLengthDelimitedField(note, 2) : undefined;
    const parsed = noteText ? decodeUtf8(noteText) : undefined;
    if (parsed !== undefined) return parsed;
  } catch {
    // Fall through to a defensive scan. Apple has changed surrounding fields
    // before; readable text should still be more useful than dropping a note.
  }

  return longestUtf8Run(gunzippedProtobufBuffer);
}

async function queryAppleNotesRows(dbPath, sqlite3Path, { execFileImpl = execFileAsync } = {}) {
  try {
    return await queryAppleNotesRowsFromSqlite(dbPath, sqlite3Path, true, { execFileImpl });
  } catch (directError) {
    if (isPermissionError(directError)) throw directError;

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-apple-notes-'));
    try {
      const copyPath = path.join(tempDir, path.basename(dbPath));
      await copySqliteFamily(dbPath, copyPath);
      return await queryAppleNotesRowsFromSqlite(copyPath, sqlite3Path, false, { execFileImpl });
    } catch (copyError) {
      if (isPermissionError(copyError)) throw copyError;
      throw directError;
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
}

async function queryAppleNotesRowsFromSqlite(dbPath, sqlite3Path, immutable, { execFileImpl = execFileAsync } = {}) {
  const database = sqliteUri(dbPath, immutable);
  const objectColumns = await sqliteTableColumns(sqlite3Path, database, 'ZICCLOUDSYNCINGOBJECT', { execFileImpl });
  const dataColumns = await sqliteTableColumns(sqlite3Path, database, 'ZICNOTEDATA', { execFileImpl });
  const sql = appleNotesRowsSql(objectColumns, dataColumns);
  const output = await runSqlite(sqlite3Path, database, sql, { execFileImpl });
  return parseAppleNotesRows(output);
}

async function sqliteTableColumns(sqlite3Path, database, table, { execFileImpl = execFileAsync } = {}) {
  const escapedTable = sqlString(table);
  const output = await runSqlite(sqlite3Path, database, `PRAGMA table_info(${escapedTable});`, { execFileImpl });
  const columns = new Set();

  for (const line of output.split(/\r?\n/)) {
    if (!line) continue;
    const parts = line.split(SQLITE_SEPARATOR);
    if (parts[1]) columns.add(parts[1]);
  }

  if (columns.size === 0) {
    throw new Error(`Apple Notes database is missing table ${table}`);
  }
  return columns;
}

function appleNotesRowsSql(objectColumns, dataColumns) {
  requireColumns(dataColumns, 'ZICNOTEDATA', ['ZDATA', 'ZNOTE']);
  requireColumns(objectColumns, 'ZICCLOUDSYNCINGOBJECT', ['Z_PK']);

  const titleExpression = firstHexTextExpression('note', objectColumns, ['ZTITLE1', 'ZTITLE']);
  const modificationExpression = firstColumnExpression('note', objectColumns, [
    'ZMODIFICATIONDATE1',
    'ZMODIFICATIONDATE',
    'ZUSERMODIFICATIONDATE',
    'ZMODIFICATIONDATE2',
  ]) ?? '0';
  const markedExpression = firstColumnExpression('note', objectColumns, ['ZMARKEDFORDELETION']) ?? '0';
  const folderJoinColumn = firstColumnName(objectColumns, ['ZFOLDER', 'ZFOLDER1']);
  const folderExpression = folderJoinColumn
    ? firstHexTextExpression('folder', objectColumns, ['ZTITLE1', 'ZTITLE2', 'ZTITLE'])
    : "''";
  const folderJoin = folderJoinColumn
    ? `LEFT JOIN ZICCLOUDSYNCINGOBJECT folder ON note.${folderJoinColumn} = folder.Z_PK`
    : '';
  const where = objectColumns.has('ZMARKEDFORDELETION')
    ? 'WHERE COALESCE(note.ZMARKEDFORDELETION, 0) != 1'
    : '';

  return `
SELECT
  note.Z_PK,
  hex(data.ZDATA),
  ${modificationExpression},
  ${titleExpression},
  ${markedExpression},
  ${folderExpression}
FROM ZICNOTEDATA data
JOIN ZICCLOUDSYNCINGOBJECT note ON data.ZNOTE = note.Z_PK
${folderJoin}
${where}
ORDER BY ${modificationExpression} DESC, note.Z_PK ASC;
`;
}

function parseAppleNotesRows(output) {
  const rows = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line) continue;
    const [
      notePk,
      zdataHex,
      modificationDate,
      titleHex,
      markedForDeletion,
      folderHex,
    ] = line.split(SQLITE_SEPARATOR);

    rows.push({
      notePk: integerOrString(notePk),
      zdata: bufferFromHex(zdataHex),
      modificationDate: coreDataTimestampToDate(modificationDate),
      title: textFromHex(titleHex),
      markedForDeletion: Number(markedForDeletion) === 1,
      folder: textFromHex(folderHex),
    });
  }
  return rows;
}

export function appleNoteRowToExposure(row) {
  if (!row || row.markedForDeletion || isRecentlyDeletedFolder(row.folder)) return undefined;

  const text = noteTextFromZdata(row.zdata);
  return appleNoteTextToExposure({
    notePk: row.notePk,
    text,
    title: row.title,
    folder: row.folder,
    modificationDate: row.modificationDate,
    metadataContentHash: contentSha256(row.zdata),
    byteLength: row.zdata.length,
  });
}

export function appleScriptNoteToExposure(note) {
  if (!note || isRecentlyDeletedFolder(note.folder)) return undefined;

  // plaintext comes from the bulk JXA path and is already tag-free — stripping
  // it would eat user-typed "<...>" text. body is the HTML shape (older script
  // output and tests) and still needs the strip.
  const text = typeof note.plaintext === 'string' && note.plaintext !== ''
    ? note.plaintext
    : noteTextFromHtml(note.body);
  const normalizedText = normalizeAppleNoteText(text);
  const contentBuffer = Buffer.from(normalizedText, 'utf8');
  const notePk = appleScriptNotePk(note.id ?? note.notePk);
  if (notePk === undefined) return undefined;

  return appleNoteTextToExposure({
    notePk,
    text: normalizedText,
    title: note.name ?? note.title,
    folder: note.folder,
    modificationDate: dateFromAppleScriptValue(note.modificationDate) ??
      dateFromAppleScriptValue(note.modifiedAt) ??
      dateFromAppleScriptValue(note.creationDate),
    metadataContentHash: contentSha256(contentBuffer),
    byteLength: contentBuffer.length,
  });
}

function appleNoteTextToExposure({
  notePk,
  text,
  title,
  folder,
  modificationDate,
  metadataContentHash,
  byteLength,
}) {
  const normalizedText = normalizeAppleNoteText(text);
  const statement = noteLeadStatement(normalizedText);
  if (!statement) return undefined;

  const dedupeContentHash = contentSha256(Buffer.from(normalizedText, 'utf8'));
  const eventDate = validDate(modificationDate) ? modificationDate : new Date(0);
  const normalizedTitle = optionalString(title);
  const normalizedFolder = optionalString(folder);

  return {
    type: 'reference',
    statement,
    sourceId: appleNoteSourceId(notePk, dedupeContentHash),
    eventAt: eventDate.toISOString(),
    context: normalizedTitle || 'apple-note',
    provenance: { surface: APPLE_NOTES_SURFACE, lane: 'deliberate' },
    frontierExcluded: true,
    metadata: {
      notePk,
      title: normalizedTitle,
      contentHash: metadataContentHash,
      byteLength,
      folder: normalizedFolder,
    },
  };
}

async function runSqlite(sqlite3Path, database, sql, { execFileImpl = execFileAsync } = {}) {
  try {
    const result = await execFileImpl(
      requiredString(sqlite3Path, 'sqlite3Path'),
      [
        '-batch',
        '-noheader',
        '-separator',
        SQLITE_SEPARATOR,
        database,
        sql,
      ],
      {
        encoding: 'utf8',
        maxBuffer: SQLITE_MAX_BUFFER,
      },
    );
    return typeof result === 'string' ? result : result?.stdout ?? '';
  } catch (error) {
    error.message = sqliteErrorMessage(error);
    throw error;
  }
}

async function appleScriptNoteCount(options) {
  const stdout = await runOsascript(APPLESCRIPT_COUNT_NOTES_SCRIPT, [], options);
  const count = Number(String(stdout ?? '').trim());
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`AppleScript Notes count returned invalid output: ${String(stdout).slice(0, 200)}`);
  }
  return count;
}

async function appleScriptNoteChunk(start, limit, options) {
  const stdout = await runOsascript(
    APPLESCRIPT_NOTE_CHUNK_SCRIPT,
    [String(start), String(limit)],
    options,
  );
  const parsed = JSON.parse(String(stdout ?? '').trim() || '[]');
  if (!Array.isArray(parsed)) throw new Error('AppleScript Notes chunk did not return an array');
  return parsed;
}

async function runOsascript(script, argv, {
  execFileImpl = execFileAsync,
  osascriptPath = APPLE_NOTES_OSASCRIPT_PATH,
  timeoutMs = APPLESCRIPT_TIMEOUT_MS,
} = {}) {
  if (timeoutMs <= 0) throw new Error('AppleScript Notes extraction timed out');

  const args = [
    '-l',
    'JavaScript',
    '-e',
    script,
    ...(argv.length > 0 ? ['--', ...argv] : []),
  ];
  const childOptions = {
    encoding: 'utf8',
    maxBuffer: APPLESCRIPT_MAX_BUFFER,
    timeout: timeoutMs,
  };
  const result = await withTimeout(
    () => execFileImpl(requiredString(osascriptPath, 'osascriptPath'), args, childOptions),
    timeoutMs,
    'AppleScript Notes extraction',
  );
  return typeof result === 'string' ? result : result?.stdout;
}

export function noteTextFromHtml(value) {
  const source = String(value ?? '');
  if (!source) return '';

  return decodeHtmlEntities(
    source
      .replace(/<\s*br\s*\/?\s*>/gi, '\n')
      .replace(/<\s*\/\s*(?:div|p|li|h[1-6]|tr|blockquote)\s*>/gi, '\n')
      .replace(/<\s*(?:div|p|li|h[1-6]|tr|blockquote)\b[^>]*>/gi, '')
      .replace(/<[^>]+>/g, ''),
  );
}

export function normalizeAppleNoteText(value) {
  return String(value ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodeHtmlEntities(value) {
  return String(value ?? '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
    const lower = entity.toLowerCase();
    if (lower === 'amp') return '&';
    if (lower === 'lt') return '<';
    if (lower === 'gt') return '>';
    if (lower === 'quot') return '"';
    if (lower === 'apos') return "'";
    if (lower === 'nbsp') return ' ';
    if (lower.startsWith('#x')) {
      return codePointEntity(Number.parseInt(lower.slice(2), 16), match);
    }
    if (lower.startsWith('#')) {
      return codePointEntity(Number.parseInt(lower.slice(1), 10), match);
    }
    return match;
  });
}

function codePointEntity(value, fallback) {
  if (!Number.isInteger(value) || value < 0 || value > 0x10ffff) return fallback;
  try {
    return String.fromCodePoint(value);
  } catch {
    return fallback;
  }
}

function appleScriptNotePk(value) {
  const text = optionalString(value);
  if (!text) return undefined;

  const uriMatch = /(?:^|\/)p([1-9]\d*)$/i.exec(text);
  if (uriMatch) return Number(uriMatch[1]);

  const number = Number(text);
  if (Number.isSafeInteger(number) && String(number) === text) return number;
  return text;
}

function appleNoteSourceId(notePk, contentHash) {
  return [
    APPLE_NOTES_SURFACE,
    notePk,
    contentHash,
  ].join(':');
}

function dateFromAppleScriptValue(value) {
  const text = optionalString(value);
  if (!text) return undefined;
  const date = new Date(text);
  return validDate(date) ? date : undefined;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function remainingTimeout(deadline, fallback) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return 0;
  return Math.min(fallback, remaining);
}

export async function withTimeout(operation, timeoutMs, label) {
  const timeout = positiveInteger(timeoutMs, APPLESCRIPT_TIMEOUT_MS);
  let timeoutId;

  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeout}ms`)),
          timeout,
        );
        timeoutId.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

function logAppleScriptFallbackFailure(logger, error, context) {
  const location = context?.path ? ` after SQLite access failed at ${context.path}` : '';
  logger?.warn?.(
    `[cs-k] ingest-apple-notes: AppleScript fallback unavailable${location}: ${errorMessage(error)}`,
  );
}

function errorMessage(error) {
  return optionalString(error?.message) ?? String(error ?? 'unknown error');
}

async function copySqliteFamily(sourcePath, targetPath) {
  await fs.copyFile(sourcePath, targetPath);
  for (const suffix of ['-wal', '-shm']) {
    try {
      await fs.copyFile(`${sourcePath}${suffix}`, `${targetPath}${suffix}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

function firstLengthDelimitedField(buffer, wantedFieldNumber) {
  let offset = 0;
  while (offset < buffer.length) {
    const field = readProtobufField(buffer, offset);
    if (field.fieldNumber === wantedFieldNumber && field.wireType === 2) {
      return field.value;
    }
    offset = field.end;
  }
  return undefined;
}

function readProtobufField(buffer, offset) {
  const key = readVarint(buffer, offset);
  const fieldNumber = Math.floor(key.value / 8);
  const wireType = key.value & 0x07;
  let cursor = key.end;

  if (fieldNumber <= 0) throw new Error(`invalid protobuf field number: ${fieldNumber}`);

  switch (wireType) {
    case 0: {
      const value = readVarint(buffer, cursor);
      return {
        fieldNumber,
        wireType,
        value: value.value,
        end: value.end,
      };
    }
    case 1:
      cursor += 8;
      break;
    case 2: {
      const length = readVarint(buffer, cursor);
      const start = length.end;
      const end = start + length.value;
      if (end > buffer.length) throw new Error('length-delimited protobuf field exceeds buffer');
      return {
        fieldNumber,
        wireType,
        value: buffer.subarray(start, end),
        end,
      };
    }
    case 5:
      cursor += 4;
      break;
    default:
      throw new Error(`unsupported protobuf wire type: ${wireType}`);
  }

  if (cursor > buffer.length) throw new Error('fixed-width protobuf field exceeds buffer');
  return {
    fieldNumber,
    wireType,
    value: undefined,
    end: cursor,
  };
}

function readVarint(buffer, offset) {
  let value = 0;
  let shift = 0;
  let cursor = offset;

  while (cursor < buffer.length) {
    const byte = buffer[cursor];
    if (shift >= 53) throw new Error('protobuf varint exceeds safe integer range');
    value += (byte & 0x7f) * (2 ** shift);
    cursor += 1;
    if ((byte & 0x80) === 0) {
      return { value, end: cursor };
    }
    shift += 7;
  }

  throw new Error('unterminated protobuf varint');
}

function decodeUtf8(buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return undefined;
  }
}

function longestUtf8Run(buffer) {
  const text = new TextDecoder('utf-8').decode(buffer);
  const runs = text
    .split(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFFFD]+/u)
    .map((run) => optionalString(run))
    .filter((run) => run && /[\p{L}\p{N}]/u.test(run));

  return runs.reduce((longest, current) =>
    current.length > (longest?.length ?? 0) ? current : longest,
  undefined);
}

function sqliteUri(file, immutable) {
  const url = pathToFileURL(file);
  url.searchParams.set('mode', 'ro');
  if (immutable) url.searchParams.set('immutable', '1');
  return url.href;
}

function firstHexTextExpression(alias, columns, candidates) {
  const names = candidates.filter((name) => columns.has(name));
  if (names.length === 0) return "''";
  return `hex(CAST(COALESCE(${names.map((name) => `${alias}.${name}`).join(', ')}, '') AS BLOB))`;
}

function firstColumnExpression(alias, columns, candidates) {
  const name = firstColumnName(columns, candidates);
  return name ? `${alias}.${name}` : undefined;
}

function firstColumnName(columns, candidates) {
  return candidates.find((name) => columns.has(name));
}

function requireColumns(columns, table, names) {
  for (const name of names) {
    if (!columns.has(name)) throw new Error(`Apple Notes database is missing ${table}.${name}`);
  }
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function bufferFromHex(value) {
  const text = String(value ?? '').trim();
  if (!text || !/^(?:[a-f0-9]{2})*$/i.test(text)) return Buffer.alloc(0);
  return Buffer.from(text, 'hex');
}

function textFromHex(value) {
  const buffer = bufferFromHex(value);
  return buffer.length > 0 ? buffer.toString('utf8') : undefined;
}

function integerOrString(value) {
  const text = requiredString(value, 'notePk');
  const number = Number(text);
  return Number.isSafeInteger(number) && String(number) === text ? number : text;
}

function coreDataTimestampToDate(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return undefined;
  return new Date((number + CORE_DATA_EPOCH_OFFSET_SECONDS) * 1000);
}

function validDate(value) {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function isRecentlyDeletedFolder(value) {
  return optionalString(value)?.toLowerCase() === RECENTLY_DELETED_FOLDER;
}

function contentSha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function fileExists(file) {
  try {
    return (await fs.stat(file)).isFile();
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

function isSkippedResult(value) {
  return Boolean(value && typeof value === 'object' && value.skipped === true);
}

function skippedResult(store, { path: dbPath, reason, message }) {
  return {
    ...(store ? { store } : {}),
    path: dbPath,
    skipped: true,
    reason,
    message,
    surface: APPLE_NOTES_SURFACE,
    exposures: [],
    createdCount: 0,
    duplicateCount: 0,
  };
}

function isPermissionError(error) {
  if (!error) return false;
  const code = error.code ?? error.cause?.code;
  if (code === 'EPERM' || code === 'EACCES') return true;
  const message = sqliteErrorMessage(error).toLowerCase();
  return (
    message.includes('operation not permitted') ||
    message.includes('permission denied') ||
    message.includes('not authorized') ||
    message.includes('authorization denied')
  );
}

function sqliteErrorMessage(error) {
  return [
    error?.message,
    error?.stderr,
    error?.stdout,
  ].filter(Boolean).join('\n');
}
