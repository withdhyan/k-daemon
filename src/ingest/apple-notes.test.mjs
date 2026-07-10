import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';

import {
  createSubstrateStore,
  exposureDedupeKey,
} from '../substrate.mjs';
import {
  APPLE_NOTES_SURFACE,
  appleScriptNoteToExposure,
  appleNotesExposureRecords,
  appleNotesExposureRecordsFromAppleScript,
  extractNoteText,
  ingestAppleNotes,
  normalizeAppleNoteText,
  noteTextFromHtml,
  noteTextFromZdata,
} from './apple-notes.mjs';

const execFileAsync = promisify(execFile);
const SQLITE3_PATH = '/usr/bin/sqlite3';
const NOTE_TEXT = 'meeting with Ana about Q3\nfollow up friday';

test('Apple Notes gzip protobuf text extraction walks NoteStoreProto fields', () => {
  const protobuf = noteStoreProtoFixture(NOTE_TEXT);
  const zdata = gzipSync(protobuf);

  assert.equal(extractNoteText(protobuf), NOTE_TEXT);
  assert.equal(noteTextFromZdata(zdata), NOTE_TEXT);
});

test('missing Apple Notes database returns a soft skipped result', async () => {
  let osascriptCalled = false;
  const result = await appleNotesExposureRecords({
    dbPath: '/nonexistent',
    osascriptExecFile: async () => {
      osascriptCalled = true;
      return { stdout: '0\n' };
    },
  });

  assert.equal(result.skipped, true);
  assert.equal(result.surface, APPLE_NOTES_SURFACE);
  assert.equal(result.reason, 'missing-db');
  assert.equal(result.path, '/nonexistent');
  assert.equal(result.createdCount, 0);
  assert.deepEqual(result.exposures, []);
  assert.equal(osascriptCalled, false);
});

test('decoded Apple note maps to the reference Exposure input shape', async (t) => {
  const zdata = gzipSync(noteStoreProtoFixture(NOTE_TEXT));
  const contentHash = sha256(zdata);
  const dedupeContentHash = sha256(Buffer.from(NOTE_TEXT, 'utf8'));
  const dbPath = await appleNotesFixtureDb(t, [
    {
      notePk: 42,
      title: 'Q3 planning',
      folder: 'Notes',
      modified: '2026-07-02T09:30:00.000Z',
      zdata,
    },
    {
      notePk: 43,
      title: 'Deleted note',
      folder: 'Notes',
      modified: '2026-07-02T09:31:00.000Z',
      markedForDeletion: true,
      zdata: gzipSync(noteStoreProtoFixture('should be skipped')),
    },
    {
      notePk: 44,
      title: 'Recently deleted note',
      folder: 'Recently Deleted',
      modified: '2026-07-02T09:32:00.000Z',
      zdata: gzipSync(noteStoreProtoFixture('should also be skipped')),
    },
  ]);

  const records = await appleNotesExposureRecords({ dbPath, sqlite3Path: SQLITE3_PATH });

  assert.equal(records.length, 1);
  assert.deepEqual(records[0], {
    type: 'reference',
    statement: 'meeting with Ana about Q3',
    sourceId: [
      APPLE_NOTES_SURFACE,
      42,
      dedupeContentHash,
    ].join(':'),
    eventAt: '2026-07-02T09:30:00.000Z',
    context: 'Q3 planning',
    provenance: { surface: APPLE_NOTES_SURFACE, lane: 'deliberate' },
    frontierExcluded: true,
    metadata: {
      notePk: 42,
      title: 'Q3 planning',
      contentHash,
      byteLength: zdata.length,
      folder: 'Notes',
    },
  });
});

test('ingestAppleNotes writes decoded note records through ingestWire', async (t) => {
  const dbPath = await appleNotesFixtureDb(t, [
    {
      notePk: 7,
      title: 'Founder note',
      folder: 'Notes',
      modified: '2026-07-01T00:00:00.000Z',
      zdata: gzipSync(noteStoreProtoFixture('Founder live note\nbody')),
    },
  ]);
  const store = await freshStore();

  const result = await ingestAppleNotes({ store, dbPath, sqlite3Path: SQLITE3_PATH });

  assert.equal(result.skipped, false);
  assert.equal(result.createdCount, 1);
  assert.equal(result.exposures[0].type, 'reference');
  assert.equal(result.exposures[0].statement, 'Founder live note');
  assert.equal(
    result.exposures[0].sourceId,
    `apple-notes:7:${sha256(Buffer.from('Founder live note\nbody', 'utf8'))}`,
  );
  assert.deepEqual(result.exposures[0].provenance, {
    surface: APPLE_NOTES_SURFACE,
    lane: 'deliberate',
  });
  assert.equal(result.exposures[0].frontierExcluded, true);
});

test('malformed or non-gzip ZDATA returns undefined and skips bad rows', async (t) => {
  assert.equal(noteTextFromZdata(Buffer.from('not gzip')), undefined);

  const dbPath = await appleNotesFixtureDb(t, [
    {
      notePk: 99,
      title: 'Bad note',
      folder: 'Notes',
      modified: '2026-07-02T09:30:00.000Z',
      zdata: Buffer.from('not gzip'),
    },
  ]);

  const records = await appleNotesExposureRecords({ dbPath, sqlite3Path: SQLITE3_PATH });

  assert.deepEqual(records, []);
});

test('SQLite permission denial falls back to AppleScript records', async (t) => {
  const dbPath = await tempFile(t, 'cs-k-apple-notes-tcc-');
  const calls = [];
  const note = appleScriptFixtureNote({
    notePk: 42,
    title: 'Q3 planning',
    body: '<div>meeting with Ana about Q3</div><div>follow up friday &amp; monday</div>',
    modified: '2026-07-02T09:30:00.000Z',
    folder: 'Notes',
  });
  const logger = captureLogger();

  const records = await appleNotesExposureRecords({
    dbPath,
    sqlite3Path: '/mock/sqlite3',
    execFileImpl: permissionDeniedExec,
    osascriptExecFile: mockOsascriptExec([note], calls),
    logger,
  });

  const normalizedText = normalizeAppleNoteText(noteTextFromHtml(note.body));
  const contentHash = sha256(Buffer.from(normalizedText, 'utf8'));

  assert.equal(records.length, 1);
  assert.deepEqual(records[0], {
    type: 'reference',
    statement: 'meeting with Ana about Q3',
    sourceId: `${APPLE_NOTES_SURFACE}:42:${contentHash}`,
    eventAt: '2026-07-02T09:30:00.000Z',
    context: 'Q3 planning',
    provenance: { surface: APPLE_NOTES_SURFACE, lane: 'deliberate' },
    frontierExcluded: true,
    metadata: {
      notePk: 42,
      title: 'Q3 planning',
      contentHash,
      byteLength: Buffer.byteLength(normalizedText, 'utf8'),
      folder: 'Notes',
    },
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(logger.warnings, []);
});

test('non-permission SQLite errors do not fall back to AppleScript', async (t) => {
  const dbPath = await tempFile(t, 'cs-k-apple-notes-broken-');
  let osascriptCalled = false;

  await assert.rejects(
    appleNotesExposureRecords({
      dbPath,
      sqlite3Path: '/mock/sqlite3',
      execFileImpl: async () => {
        throw new Error('sqlite schema changed');
      },
      osascriptExecFile: async () => {
        osascriptCalled = true;
        return { stdout: '0\n' };
      },
    }),
    /sqlite schema changed/,
  );
  assert.equal(osascriptCalled, false);
});

test('SQLite and AppleScript paths produce identical dedupe keys for the same note', async (t) => {
  const zdata = gzipSync(noteStoreProtoFixture(NOTE_TEXT));
  const dbPath = await appleNotesFixtureDb(t, [
    {
      notePk: 42,
      title: 'Q3 planning',
      folder: 'Notes',
      modified: '2026-07-02T09:30:00.000Z',
      zdata,
    },
  ]);

  const sqliteRecords = await appleNotesExposureRecords({ dbPath, sqlite3Path: SQLITE3_PATH });
  const appleScriptRecord = appleScriptNoteToExposure(appleScriptFixtureNote({
    notePk: 42,
    title: 'Q3 planning',
    body: '<div>meeting with Ana about Q3</div><div>follow up friday</div>',
    modified: '2026-07-02T09:30:00.000Z',
    folder: 'Notes',
  }));

  assert.equal(appleScriptRecord.sourceId, sqliteRecords[0].sourceId);
  assert.equal(exposureDedupeKey(appleScriptRecord), exposureDedupeKey(sqliteRecords[0]));
});

test('AppleScript note bodies are stripped from HTML before statement extraction', () => {
  const body = '<div><b>meeting</b> &amp; <span>Ana</span></div><div>second&nbsp;line</div>';
  const record = appleScriptNoteToExposure(appleScriptFixtureNote({
    notePk: 5,
    title: 'HTML note',
    body,
    modified: '2026-07-02T09:30:00.000Z',
    folder: 'Notes',
  }));

  assert.equal(normalizeAppleNoteText(noteTextFromHtml(body)), 'meeting & Ana\nsecond line');
  assert.equal(record.statement, 'meeting & Ana');
});

test('AppleScript plaintext is preferred over body and never HTML-stripped', () => {
  const record = appleScriptNoteToExposure(appleScriptFixtureNote({
    notePk: 6,
    title: 'plaintext note',
    body: '<div>stale html shape</div>',
    plaintext: 'ping me <3 when x < y',
    modified: '2026-07-02T09:30:00.000Z',
    folder: 'Notes',
  }));

  assert.equal(record.statement, 'ping me <3 when x < y');
});

test('AppleScript fallback failure logs and returns empty records', async (t) => {
  const dbPath = await tempFile(t, 'cs-k-apple-notes-denied-');
  const logger = captureLogger();

  const records = await appleNotesExposureRecords({
    dbPath,
    sqlite3Path: '/mock/sqlite3',
    execFileImpl: permissionDeniedExec,
    osascriptExecFile: async () => {
      throw new Error('automation denied');
    },
    logger,
  });

  assert.deepEqual(records, []);
  assert.equal(logger.warnings.length, 1);
  assert.match(logger.warnings[0], /AppleScript fallback unavailable/);
  assert.match(logger.warnings[0], /automation denied/);
});

test('AppleScript extraction chunks notes across multiple osascript calls', async () => {
  const notes = [
    appleScriptFixtureNote({ notePk: 1, title: 'One', body: '<div>one</div>' }),
    appleScriptFixtureNote({ notePk: 2, title: 'Two', body: '<div>two</div>' }),
    appleScriptFixtureNote({ notePk: 3, title: 'Three', body: '<div>three</div>' }),
  ];
  const calls = [];

  const records = await appleNotesExposureRecordsFromAppleScript({
    execFileImpl: mockOsascriptExec(notes, calls),
    osascriptPath: '/mock/osascript',
    chunkSize: 2,
    timeoutMs: 5_000,
    totalTimeoutMs: 30_000,
    logger: { warn: () => assert.fail('mocked AppleScript should not warn') },
  });

  const chunkArgv = calls
    .map((call) => call.args.slice(call.args.indexOf('--') + 1))
    .filter((argv) => argv.length === 2);
  assert.deepEqual(chunkArgv, [['0', '2'], ['2', '2']]);
  assert.deepEqual(records.map((record) => record.metadata.notePk), [1, 2, 3]);
});

function noteStoreProtoFixture(text) {
  const note = concatBuffers([
    protobufVarintField(1, 123),
    protobufBytesField(2, Buffer.from(text, 'utf8')),
  ]);
  const document = concatBuffers([
    protobufBytesField(1, Buffer.from('ignored', 'utf8')),
    protobufBytesField(3, note),
  ]);
  return concatBuffers([
    protobufVarintField(1, 1),
    protobufBytesField(2, document),
  ]);
}

function protobufVarintField(fieldNumber, value) {
  return concatBuffers([
    encodeVarint((fieldNumber << 3) | 0),
    encodeVarint(value),
  ]);
}

function protobufBytesField(fieldNumber, value) {
  return concatBuffers([
    encodeVarint((fieldNumber << 3) | 2),
    encodeVarint(value.length),
    value,
  ]);
}

function encodeVarint(value) {
  const bytes = [];
  let current = value;
  do {
    let byte = current & 0x7f;
    current = Math.floor(current / 128);
    if (current > 0) byte |= 0x80;
    bytes.push(byte);
  } while (current > 0);
  return Buffer.from(bytes);
}

function concatBuffers(buffers) {
  return Buffer.concat(buffers);
}

async function appleNotesFixtureDb(t, notes) {
  const dir = await tempDir(t, 'cs-k-apple-notes-db-');
  const dbPath = path.join(dir, 'NoteStore.sqlite');
  const folderIds = new Map();
  let nextFolderId = 1000;

  const sql = [
    'CREATE TABLE ZICCLOUDSYNCINGOBJECT (Z_PK INTEGER PRIMARY KEY, ZTITLE1 TEXT, ZMODIFICATIONDATE1 REAL, ZMARKEDFORDELETION INTEGER, ZFOLDER INTEGER);',
    'CREATE TABLE ZICNOTEDATA (Z_PK INTEGER PRIMARY KEY, ZNOTE INTEGER, ZDATA BLOB);',
  ];

  for (const note of notes) {
    let folderId = folderIds.get(note.folder);
    if (!folderId) {
      folderId = nextFolderId;
      nextFolderId += 1;
      folderIds.set(note.folder, folderId);
      sql.push(
        `INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, ZTITLE1, ZMODIFICATIONDATE1, ZMARKEDFORDELETION, ZFOLDER) VALUES (${folderId}, ${sqlQuote(note.folder)}, 0, 0, NULL);`,
      );
    }

    sql.push(
      `INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, ZTITLE1, ZMODIFICATIONDATE1, ZMARKEDFORDELETION, ZFOLDER) VALUES (${note.notePk}, ${sqlQuote(note.title)}, ${coreDataTimestamp(note.modified)}, ${note.markedForDeletion ? 1 : 0}, ${folderId});`,
      `INSERT INTO ZICNOTEDATA (Z_PK, ZNOTE, ZDATA) VALUES (${note.notePk + 5000}, ${note.notePk}, X'${note.zdata.toString('hex')}');`,
    );
  }

  await execFileAsync(SQLITE3_PATH, [dbPath, sql.join('\n')], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  return dbPath;
}

function coreDataTimestamp(iso) {
  return (new Date(iso).getTime() / 1000) - 978307200;
}

function sqlQuote(value) {
  return `'${String(value ?? '').replaceAll("'", "''")}'`;
}

async function freshStore() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-apple-notes-data-'));
  return createSubstrateStore({ dataDir, now: () => new Date('2026-07-03T00:00:00.000Z') });
}

async function tempDir(t, prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

async function tempFile(t, prefix) {
  const dir = await tempDir(t, prefix);
  const file = path.join(dir, 'NoteStore.sqlite');
  await fs.writeFile(file, '');
  return file;
}

async function permissionDeniedExec() {
  const error = new Error('operation not permitted');
  error.code = 'EPERM';
  throw error;
}

function mockOsascriptExec(notes, calls = []) {
  return async (file, args, options) => {
    calls.push({ file, args, options });
    const argvIndex = args.indexOf('--');
    if (argvIndex === -1) return { stdout: `${notes.length}\n`, stderr: '' };

    const start = Number(args[argvIndex + 1]);
    const limit = Number(args[argvIndex + 2]);
    return {
      stdout: `${JSON.stringify(notes.slice(start, start + limit))}\n`,
      stderr: '',
    };
  };
}

function appleScriptFixtureNote({
  notePk,
  title,
  body,
  plaintext,
  modified = '2026-07-02T09:30:00.000Z',
  created = '2026-07-01T09:30:00.000Z',
  folder = 'Notes',
}) {
  return {
    id: `x-coredata://12345678-1234-1234-1234-123456789abc/ICNote/p${notePk}`,
    name: title,
    body,
    ...(plaintext !== undefined ? { plaintext } : {}),
    creationDate: created,
    modificationDate: modified,
    folder,
  };
}

function captureLogger() {
  const warnings = [];
  return {
    warnings,
    warn: (message) => warnings.push(String(message)),
  };
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}
