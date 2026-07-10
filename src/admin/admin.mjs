import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { runAgentTurn, SovereignLaneError } from '../agent/chat.mjs';
import { isPlainObject, optionalString, stripUndefined } from '../substrate.mjs';

export const ADMIN_TYPES = Object.freeze(['TimeSensitive', 'RegularQueue', 'Recurring']);
export const ADMIN_EFFORTS = Object.freeze(['Quick', 'Hour', 'Hours']);
export const ADMIN_INTAKE_PATH = '/api/admin/intake';
export const ADMIN_CONFIRM_PATH = '/api/admin/intake/confirm';
export const ADMIN_ITEMS_PATH = '/api/admin/items';

const ADMIN_BANDISH_SCHEMA_VERSION = 1;
const ADMIN_PARSE_CONFIRM_SCHEMA_VERSION = 1;
const ADMIN_BANDISH_DIR = path.join('admin', 'bandish');
const TITLE_MAX_CHARS = 160;
const NOTE_MAX_CHARS = 500;
const SOURCE_MAX_CHARS = 1000;
const EFFORT_RANK = Object.freeze({ Quick: 0, Hour: 1, Hours: 2 });

const ADMIN_INTAKE_SYSTEM_PROMPT = [
  'You are K parsing one founder admin ops intake.',
  'Return exactly one admin.parse_intake tool call. No prose.',
  'Resolve relative dates against the supplied today value and return date-only strings as YYYY-MM-DD.',
  'AdminBandish fields: type is TimeSensitive, RegularQueue, or Recurring; effort is Quick, Hour, or Hours.',
  'Use TimeSensitive when a hard due date exists, Recurring when the item repeats, otherwise RegularQueue.',
  'Use null for missing remindDate or dueDate. Do not invent a hard due date.',
  'Put the smallest plain task label in title; preserve useful context in note.',
].join('\n');

export async function parseAdminIntakeWithK(input = {}, context = {}) {
  const text = optionalString(input.text ?? input.message ?? input.userMessage);
  if (!text) throw codedError('empty_intake');

  const now = context.now ?? (() => new Date());
  const runTurn = context.runTurn ?? runAgentTurn;
  const today = dateOnly(nowValue(now));
  const deps = isPlainObject(context.deps) ? context.deps : {};

  let result;
  try {
    result = await runTurn(
      {
        userMessage: [
          `today: ${today}`,
          `source: ${context.surface ?? 'admin'}`,
          'intake:',
          text,
        ].join('\n'),
        systemPrompt: ADMIN_INTAKE_SYSTEM_PROMPT,
        sovereignFloor: true,
        tools: true,
        toolIds: ['admin.parse_intake'],
        dataDir: context.dataDir,
        now,
        signal: context.signal,
      },
      {
        ...deps,
        toolExecutor: deps.toolExecutor ?? context.toolExecutor,
      },
    );
  } catch (error) {
    if (error instanceof SovereignLaneError) throw error;
    throw codedError('admin_parse_failed', { cause: error });
  }

  const toolParseConfirm = firstAdminParseConfirm(result?.toolResults);
  if (!toolParseConfirm) throw codedError('admin_parse_missing_confirm');
  const parseConfirm = toolParseConfirm.sourceText
    ? toolParseConfirm
    : buildAdminParseConfirm(toolParseConfirm.parsed, {
        now,
        sourceText: text,
        source: context.surface ?? 'admin',
      });

  return stripUndefined({
    ok: true,
    state: 'parse_confirm',
    parseConfirm,
    lane: result.lane,
    sensitivity: result.sensitivity,
    sovereign: result.sovereign,
    steps: result.steps,
    held: result.held,
  });
}

export function executeAdminParseIntakeTool(args = {}, context = {}) {
  const adminContext = isPlainObject(context.admin) ? context.admin : {};
  const now = context.now ?? (() => new Date());
  const sourceText = boundText(
    optionalString(adminContext.sourceText ?? args.sourceText) ?? '',
    SOURCE_MAX_CHARS,
  );

  const base = {
    sensitive: true,
    sensitivity: 'sensitive',
    frontierExcluded: true,
    provenance: ['founder', 'admin'],
  };

  try {
    const parsed = normalizeAdminParsedFields(args, { now });
    const parseConfirm = buildAdminParseConfirm(parsed, {
      now,
      sourceText,
      source: optionalString(adminContext.source) ?? 'admin',
    });

    return Object.freeze({
      ok: true,
      output: formatParseConfirmOutput(parseConfirm),
      ...base,
      artifacts: Object.freeze({ adminParseConfirm: parseConfirm }),
    });
  } catch (error) {
    return Object.freeze({
      ok: false,
      reason: optionalString(error?.code ?? error?.message) ?? 'invalid_admin_intake',
      ...base,
    });
  }
}

export async function commitAdminParseConfirm(input = {}, context = {}) {
  const parseConfirm = isPlainObject(input.parseConfirm) ? input.parseConfirm : {};
  const parsedInput =
    input.parsed ??
    input.fields ??
    parseConfirm.parsed;
  const parsed = normalizeAdminParsedFields(parsedInput, { now: context.now });
  const now = context.now ?? (() => new Date());
  const sourceText = boundText(
    optionalString(input.sourceText ?? parseConfirm.sourceText) ?? '',
    SOURCE_MAX_CHARS,
  );
  const commitToken = optionalString(input.commitToken ?? parseConfirm.commitToken) ??
    adminCommitToken({ parsed, sourceText });
  const store = createAdminStore({ dataDir: context.dataDir, now });
  const result = await store.writeBandish({
    ...parsed,
    sourceText,
    sourceParseId: commitToken,
    committedFrom: 'parse_confirm',
  });

  return Object.freeze({
    ok: true,
    committed: true,
    created: result.created,
    item: result.record,
  });
}

export function createAdminStore(options = {}) {
  return new AdminStore(options);
}

export class AdminStore {
  constructor(options = {}) {
    this.dataDir = path.resolve(options.dataDir ?? path.join(process.cwd(), 'data'));
    this.now = options.now ?? (() => new Date());
    this.rootDir = path.join(this.dataDir, ADMIN_BANDISH_DIR);
  }

  async writeBandish(input = {}) {
    const record = buildAdminBandishRecord(input, { now: this.now });
    await fs.mkdir(this.rootDir, { recursive: true });
    const file = path.join(this.rootDir, `${record.id}.json`);
    try {
      const existing = JSON.parse(await fs.readFile(file, 'utf8'));
      return { record: existing, created: false };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await fs.writeFile(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    return { record, created: true };
  }

  async listBandish() {
    let entries = [];
    try {
      entries = await fs.readdir(this.rootDir, { withFileTypes: true });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    const records = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      records.push(JSON.parse(await fs.readFile(path.join(this.rootDir, entry.name), 'utf8')));
    }
    return records.sort(compareAdminBandish);
  }
}

export function normalizeAdminParsedFields(input = {}, options = {}) {
  if (!isPlainObject(input)) throw codedError('invalid_admin_fields');
  const title = boundRequiredText(input.title ?? input.task ?? input.label, 'title', TITLE_MAX_CHARS);
  const recurrence = normalizeRecurrence(input.recurrence);
  const dueDate = normalizeDateOnly(input.dueDate ?? input.due ?? input.dueAt, 'dueDate');
  const remindDate = normalizeDateOnly(input.remindDate ?? input.remind ?? input.remindAt, 'remindDate');
  const type = normalizeAdminType(input.type, { dueDate, recurrence });
  const effort = normalizeEffort(input.effort);
  const note = boundOptionalText(input.note ?? input.context, NOTE_MAX_CHARS);
  const warnings = adminParseWarnings({ type, remindDate, dueDate, recurrence });

  return Object.freeze(stripUndefined({
    title,
    type,
    effort,
    remindDate,
    dueDate,
    recurrence,
    note,
    warnings,
  }));
}

export function buildAdminParseConfirm(parsedInput = {}, options = {}) {
  const parsed = normalizeAdminParsedFields(parsedInput, { now: options.now });
  const sourceText = boundText(optionalString(options.sourceText) ?? '', SOURCE_MAX_CHARS);
  const generatedAt = isoNow(options.now);
  const commitToken = adminCommitToken({ parsed, sourceText });

  return Object.freeze(stripUndefined({
    kind: 'admin.parse_confirm',
    schemaVersion: ADMIN_PARSE_CONFIRM_SCHEMA_VERSION,
    state: 'parse_confirm',
    committed: false,
    commitToken,
    generatedAt,
    source: optionalString(options.source) ?? 'admin',
    sourceText,
    parsed,
    editableFields: ['title', 'type', 'effort', 'remindDate', 'dueDate', 'recurrence', 'note'],
    priority: adminPriority(parsed),
    confirmAction: {
      method: 'POST',
      path: ADMIN_CONFIRM_PATH,
      body: {
        commitToken,
        sourceText,
        parsed,
      },
    },
  }));
}

export function buildAdminBandishRecord(input = {}, options = {}) {
  const parsed = normalizeAdminParsedFields(input, { now: options.now });
  const now = options.now ?? (() => new Date());
  const committedAt = isoNow(now);
  const sourceText = boundText(optionalString(input.sourceText) ?? '', SOURCE_MAX_CHARS);
  const dedupeKey = adminBandishDedupeKey(parsed);

  return Object.freeze(stripUndefined({
    id: `admin_${hashText(dedupeKey).slice(0, 24)}`,
    kind: 'AdminBandish',
    schemaVersion: ADMIN_BANDISH_SCHEMA_VERSION,
    status: 'open',
    dedupeKey,
    title: parsed.title,
    type: parsed.type,
    effort: parsed.effort,
    remindDate: parsed.remindDate ?? null,
    dueDate: parsed.dueDate ?? null,
    recurrence: parsed.recurrence ?? null,
    note: parsed.note,
    priority: adminPriority(parsed),
    source: {
      surface: 'admin',
      sourceText,
      sourceParseId: optionalString(input.sourceParseId),
      committedFrom: optionalString(input.committedFrom) ?? 'manual',
    },
    committedAt,
    updatedAt: committedAt,
  }));
}

export function adminPriority(parsedInput = {}) {
  const parsed = normalizeAdminParsedFields(parsedInput);
  return Object.freeze({
    remindDate: parsed.remindDate ?? null,
    dueDate: parsed.dueDate ?? null,
    effortRank: EFFORT_RANK[parsed.effort],
    sortKey: [
      parsed.remindDate ?? '9999-12-31',
      parsed.dueDate ?? '9999-12-31',
      String(EFFORT_RANK[parsed.effort]).padStart(2, '0'),
      parsed.title.toLowerCase(),
    ].join('|'),
  });
}

function normalizeAdminType(value, { dueDate, recurrence } = {}) {
  const text = optionalString(value);
  if (text && ADMIN_TYPES.includes(text)) return text;
  if (text) {
    const compact = text.toLowerCase().replace(/[^a-z]/g, '');
    if (compact === 'timesensitive') return 'TimeSensitive';
    if (compact === 'regularqueue') return 'RegularQueue';
    if (compact === 'recurring') return 'Recurring';
  }
  if (recurrence) return 'Recurring';
  if (dueDate) return 'TimeSensitive';
  return 'RegularQueue';
}

function normalizeEffort(value) {
  const text = optionalString(value);
  if (text && ADMIN_EFFORTS.includes(text)) return text;
  if (text) {
    const compact = text.toLowerCase().replace(/[^a-z]/g, '');
    if (compact === 'quick') return 'Quick';
    if (compact === 'hour') return 'Hour';
    if (compact === 'hours') return 'Hours';
  }
  return 'Quick';
}

function normalizeRecurrence(value) {
  if (value === undefined || value === null || value === false) return undefined;
  if (typeof value === 'string') {
    const description = boundOptionalText(value, 160);
    return description ? Object.freeze({ description }) : undefined;
  }
  if (!isPlainObject(value)) throw codedError('invalid_recurrence');
  const description = boundOptionalText(value.description ?? value.rule ?? value.text, 160);
  const frequency = boundOptionalText(value.frequency ?? value.freq, 40);
  const interval = finitePositiveInteger(value.interval);
  const anchorDate = normalizeDateOnly(value.anchorDate ?? value.startDate, 'recurrence.anchorDate');
  return Object.freeze(stripUndefined({
    description,
    frequency,
    interval,
    anchorDate,
  }));
}

function normalizeDateOnly(value, label) {
  if (value === undefined || value === null || value === '') return undefined;
  const text = optionalString(value);
  if (!text) return undefined;
  const datePrefix = /^(\d{4}-\d{2}-\d{2})(?:T|$)/.exec(text)?.[1];
  if (datePrefix) {
    assertValidDateOnly(datePrefix, label);
    return datePrefix;
  }
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) throw codedError(`invalid_${label}`);
  return dateOnly(date);
}

function assertValidDateOnly(value, label) {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || dateOnly(date) !== value) {
    throw codedError(`invalid_${label}`);
  }
}

function adminParseWarnings({ type, remindDate, dueDate, recurrence }) {
  const warnings = [];
  if (type === 'TimeSensitive' && !dueDate) warnings.push('missing_due_date');
  if (!remindDate) warnings.push('missing_remind_date');
  if (remindDate && dueDate && remindDate === dueDate) warnings.push('remind_equals_due');
  if (remindDate && dueDate && remindDate > dueDate) warnings.push('remind_after_due');
  if (type === 'Recurring' && !recurrence) warnings.push('missing_recurrence');
  return Object.freeze(warnings);
}

function adminBandishDedupeKey(parsed) {
  return stableJson({
    title: parsed.title,
    type: parsed.type,
    effort: parsed.effort,
    remindDate: parsed.remindDate ?? null,
    dueDate: parsed.dueDate ?? null,
    recurrence: parsed.recurrence ?? null,
  });
}

function adminCommitToken({ parsed, sourceText }) {
  return `admin_pc_${hashText(stableJson({ parsed, sourceText })).slice(0, 24)}`;
}

function firstAdminParseConfirm(toolResults) {
  if (!Array.isArray(toolResults)) return null;
  for (const result of toolResults) {
    const artifact = result?.artifacts?.adminParseConfirm;
    if (isPlainObject(artifact) && artifact.kind === 'admin.parse_confirm') return artifact;
  }
  return null;
}

function formatParseConfirmOutput(parseConfirm) {
  const parsed = parseConfirm.parsed;
  return [
    'admin.parse_confirm',
    `title=${parsed.title}`,
    `type=${parsed.type}`,
    `effort=${parsed.effort}`,
    `remindDate=${parsed.remindDate ?? 'null'}`,
    `dueDate=${parsed.dueDate ?? 'null'}`,
    `warnings=${Array.isArray(parsed.warnings) ? parsed.warnings.join(',') : ''}`,
  ].join('\n');
}

function compareAdminBandish(a, b) {
  return (
    String(a?.priority?.sortKey ?? '').localeCompare(String(b?.priority?.sortKey ?? '')) ||
    String(a?.committedAt ?? '').localeCompare(String(b?.committedAt ?? '')) ||
    String(a?.id ?? '').localeCompare(String(b?.id ?? ''))
  );
}

function boundRequiredText(value, label, maxChars) {
  const text = boundOptionalText(value, maxChars);
  if (!text) throw codedError(`missing_${label}`);
  return text;
}

function boundOptionalText(value, maxChars) {
  const text = optionalString(value);
  return text ? boundText(text, maxChars) : undefined;
}

function boundText(value, maxChars) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > maxChars ? text.slice(0, maxChars).trim() : text;
}

function finitePositiveInteger(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw codedError('invalid_recurrence_interval');
  return number;
}

function dateOnly(value) {
  return value.toISOString().slice(0, 10);
}

function nowValue(now) {
  return now instanceof Date ? now : now();
}

function isoNow(now) {
  return nowValue(now).toISOString();
}

function hashText(text) {
  return createHash('sha256').update(text).digest('hex');
}

function codedError(code, options = {}) {
  const error = new Error(code, options);
  error.code = code;
  return error;
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}
