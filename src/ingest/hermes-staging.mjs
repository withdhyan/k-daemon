import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  safeDataPath,
} from '../../daemon/run.mjs';
import {
  isPlainObject,
  optionalString,
  requiredString,
} from '../substrate.mjs';

// ── U7 · staged-skills store (daemon-owned) ─────────────────────────────────
// Foreign SKILL.md bodies live here as STAGED records, deliberately OUTSIDE
// U6's loader scan root (`skills/`) so nothing here is discoverable/runnable
// until the founder approves it and the daemon writes a vetted copy into the
// owned loader path (plan C-02/C-03). Writes go only through this module via
// the daemon (daemon-owns-writes). Filenames are content-derived ids, never a
// model-supplied path (KTD5 path-guard via safeDataPath).
//
// Supersession-not-mutation: an unchanged upstream skill is a no-op (dedup by
// contentHash); a CHANGED upstream skill supersedes the prior staged record
// (validFrom/validTo + supersededById) rather than overwriting it.

export const STAGED_SKILLS_DIR = 'staged-skills';
export const STAGED_SKILL_STATUSES = Object.freeze(['pending', 'approved', 'rejected']);

const SKILLS_SUBDIR = 'skills';
const NOTES_SUBDIR = 'capability-notes';
const SKILL_ID_PATTERN = /^skl-[a-f0-9]{24}$/;
const NOTE_ID_PATTERN = /^cap-[a-f0-9]{24}$/;

export function createStagedSkillsStore(options = {}) {
  return new StagedSkillsStore(options);
}

export class StagedSkillsStore {
  constructor(options = {}) {
    this.dataDir = path.resolve(options.dataDir ?? path.join(process.cwd(), 'data'));
    this.now = options.now ?? (() => new Date());
  }

  #skillsDir() {
    return safeDataPath(this.dataDir, path.join(STAGED_SKILLS_DIR, SKILLS_SUBDIR));
  }

  #notesDir() {
    return safeDataPath(this.dataDir, path.join(STAGED_SKILLS_DIR, NOTES_SUBDIR));
  }

  #skillFile(skillId) {
    assertSkillId(skillId);
    return safeDataPath(
      this.dataDir,
      path.join(STAGED_SKILLS_DIR, SKILLS_SUBDIR, `${skillId}.json`),
    );
  }

  #noteFile(noteId) {
    assertNoteId(noteId);
    return safeDataPath(
      this.dataDir,
      path.join(STAGED_SKILLS_DIR, NOTES_SUBDIR, `${noteId}.json`),
    );
  }

  async listSkills() {
    return readRecordsFromDir(this.#skillsDir());
  }

  async listNotes() {
    return readRecordsFromDir(this.#notesDir());
  }

  async readSkill(skillId) {
    return readJsonIfPresent(this.#skillFile(skillId));
  }

  // Diff a freshly-fetched normalized staged skill against what's on disk.
  // - no prior live record  → create (new)
  // - identical contentHash → no-op (duplicate)
  // - changed contentHash   → supersede prior (validTo + supersededById)
  async stageSkill(input) {
    const staged = normalizeStagedSkill(input);
    const current = await this.readSkill(staged.skillId);

    if (current && current.contentHash === staged.contentHash && isLive(current)) {
      return { record: current, outcome: 'duplicate' };
    }

    const nowIso = this.now().toISOString();
    if (current && isLive(current)) {
      const supersededPath = await this.#archiveSuperseded(current, nowIso, staged);
      const record = {
        ...staged,
        status: 'pending',
        validFrom: nowIso,
        validTo: null,
        supersededById: null,
        supersedes: current.recordId,
        supersededArchive: supersededPath,
      };
      record.recordId = recordIdFor(staged.skillId, staged.contentHash);
      await this.#writeSkill(record);
      return { record, outcome: 'superseded' };
    }

    const record = {
      ...staged,
      status: 'pending',
      validFrom: nowIso,
      validTo: null,
      supersededById: null,
      recordId: recordIdFor(staged.skillId, staged.contentHash),
    };
    await this.#writeSkill(record);
    return { record, outcome: 'created' };
  }

  async stageNote(input) {
    const note = normalizeStagedNote(input);
    const current = await readJsonIfPresent(this.#noteFile(note.noteId));
    if (current && current.contentHash === note.contentHash) {
      return { record: current, outcome: 'duplicate' };
    }

    const record = {
      ...note,
      status: 'pending',
      stagedAt: this.now().toISOString(),
    };
    await this.#writeNote(record);
    return { record, outcome: current ? 'updated' : 'created' };
  }

  // Approve is the ONLY transition that could ever lead to activation — and even
  // then it merely MARKS the record; the actual owned-loader write is a separate
  // daemon step (plan C-02). Nothing here executes foreign code. [auto] empty.
  async setSkillStatus(skillId, status, options = {}) {
    const nextStatus = assertStatus(status);
    const record = await this.readSkill(skillId);
    if (!record) return null;
    if (!isLive(record)) return { record, changed: false };

    const decidedAt = this.now().toISOString();
    const updated = {
      ...record,
      status: nextStatus,
      decidedAt,
      decisionNote: optionalString(options.note) ?? record.decisionNote ?? '',
    };
    await this.#writeSkill(updated);
    return { record: updated, changed: true };
  }

  async #archiveSuperseded(current, nowIso, replacement) {
    const retired = {
      ...current,
      validTo: nowIso,
      supersededById: recordIdFor(replacement.skillId, replacement.contentHash),
    };
    const archiveRel = path.join(
      STAGED_SKILLS_DIR,
      SKILLS_SUBDIR,
      'superseded',
      `${current.skillId}-${current.contentHash.slice(0, 12)}.json`,
    );
    const archiveFile = safeDataPath(this.dataDir, archiveRel);
    await fs.mkdir(path.dirname(archiveFile), { recursive: true });
    await fs.writeFile(archiveFile, `${JSON.stringify(retired, null, 2)}\n`, 'utf8');
    return archiveRel;
  }

  async #writeSkill(record) {
    const file = this.#skillFile(record.skillId);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  }

  async #writeNote(record) {
    const file = this.#noteFile(record.noteId);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  }
}

function isLive(record) {
  return !record.validTo && !record.supersededById;
}

function recordIdFor(skillId, contentHash) {
  return `${skillId}@${contentHash.slice(0, 12)}`;
}

function normalizeStagedSkill(input) {
  if (!isPlainObject(input)) throw new Error('staged skill must be an object');
  const skillId = requiredString(input.skillId, 'skillId');
  assertSkillId(skillId);
  const kind = optionalString(input.kind) === 'StagedSkillProposal'
    ? 'StagedSkillProposal'
    : 'StagedSkill';
  return {
    kind,
    schemaVersion: 1,
    surface: optionalString(input.surface) ?? 'hermes',
    ...(kind === 'StagedSkillProposal'
      ? {
          origin: optionalString(input.origin) ?? 'self_review',
          proposalEvidence: stringList(input.proposalEvidence),
          gist: optionalString(input.gist) ?? '',
          diffPreview: optionalString(input.diffPreview) ?? '',
          beforeAfterMeasure: optionalString(input.beforeAfterMeasure) ?? '',
          governanceTag: optionalString(input.governanceTag) ?? '[gate:human]',
        }
      : {}),
    skillId,
    name: requiredString(input.name, 'skill name'),
    description: optionalString(input.description) ?? '',
    version: optionalString(input.version) ?? '',
    license: optionalString(input.license) ?? '',
    author: optionalString(input.author) ?? '',
    homepage: optionalString(input.homepage) ?? '',
    tags: stringList(input.tags),
    declaredTools: stringList(input.declaredTools),
    sourcePath: requiredString(input.sourcePath, 'sourcePath'),
    sourceRepo: optionalString(input.sourceRepo) ?? '',
    sourceRef: optionalString(input.sourceRef) ?? '',
    sourceSha: optionalString(input.sourceSha) ?? '',
    contentHash: requiredString(input.contentHash, 'contentHash'),
    byteLength: Number.isInteger(input.byteLength) ? input.byteLength : 0,
    lineCount: Number.isInteger(input.lineCount) ? input.lineCount : 0,
    rawBody: requiredString(input.rawBody, 'rawBody'),
    threatFlags: stringList(input.threatFlags),
    // Foreign code ALWAYS requires founder review before it can activate.
    requiresReview: true,
  };
}

function normalizeStagedNote(input) {
  if (!isPlainObject(input)) throw new Error('capability note must be an object');
  const noteId = requiredString(input.noteId, 'noteId');
  assertNoteId(noteId);
  return {
    kind: 'HermesCapabilityNote',
    schemaVersion: 1,
    surface: optionalString(input.surface) ?? 'hermes',
    noteId,
    tag: optionalString(input.tag) ?? '',
    name: optionalString(input.name) ?? '',
    publishedAt: optionalString(input.publishedAt) ?? '',
    url: optionalString(input.url) ?? '',
    body: optionalString(input.body) ?? '',
    contentHash: requiredString(input.contentHash, 'contentHash'),
  };
}

function stringList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => optionalString(item)).filter(Boolean);
}

async function readRecordsFromDir(dir) {
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  const records = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const record = await readJsonIfPresent(path.join(dir, entry.name));
    if (record) records.push(record);
  }
  return records.sort((a, b) => String(a.name ?? a.tag ?? '').localeCompare(String(b.name ?? b.tag ?? '')));
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

function assertSkillId(value) {
  const id = requiredString(value, 'skillId');
  if (!SKILL_ID_PATTERN.test(id)) throw new Error(`invalid skillId: ${id}`);
  return id;
}

function assertNoteId(value) {
  const id = requiredString(value, 'noteId');
  if (!NOTE_ID_PATTERN.test(id)) throw new Error(`invalid noteId: ${id}`);
  return id;
}

function assertStatus(value) {
  const status = requiredString(value, 'status');
  if (!STAGED_SKILL_STATUSES.includes(status)) {
    throw new Error(`invalid staged-skill status: ${status}`);
  }
  return status;
}
