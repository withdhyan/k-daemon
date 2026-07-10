import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  isPlainObject,
  optionalString,
  requiredString,
  stripUndefined,
} from '../substrate.mjs';

export const ADMIN_DIR = 'admin';
export const ADMIN_ITEMS_DIR = path.join(ADMIN_DIR, 'items');
export const ADMIN_STREAM_DIR = path.join(ADMIN_DIR, 'stream');
export const OPS_GROUPS_DIR = path.join(ADMIN_DIR, 'ops-groups');
export const OPS_GROUP_RECORDS_DIR = path.join(OPS_GROUPS_DIR, 'groups');
export const OPS_GROUP_ITEMS_DIR = path.join(OPS_GROUPS_DIR, 'items');
export const OPS_COMPLETIONS_DIR = path.join(OPS_GROUPS_DIR, 'completions');

export const ADMIN_TYPES = Object.freeze(['TimeSensitive', 'RegularQueue', 'Recurring']);
export const ADMIN_EFFORTS = Object.freeze(['Quick', 'Hour', 'Hours']);
export const ADMIN_STATUSES = Object.freeze(['open', 'complete']);
export const OPS_COMPLETION_STATUSES = Object.freeze(['done', 'skipped']);
export const ADMIN_TRIAGE_TOOLS = Object.freeze(['admin.add', 'admin.reschedule', 'admin.complete']);

const SCHEMA_VERSION = 1;
const ID_PATTERN = /^[a-z][a-z0-9_:-]{2,127}$/;
const TITLE_MAX_CHARS = 240;
const NOTE_MAX_CHARS = 1000;

export function createOpsGroupStore(options = {}) {
  return new OpsGroupStore(options);
}

export class OpsGroupStore {
  constructor(options = {}) {
    this.dataDir = path.resolve(options.dataDir ?? path.join(process.cwd(), 'data'));
    this.now = normalizeNow(options.now);
  }

  async saveGroup(input = {}) {
    const existing = input.id ? await this.loadGroup(input.id) : null;
    const group = normalizeOpsGroup(input, { now: this.now(), existing });
    await writeJson(this.#groupPath(group.id), group);
    return clone(group);
  }

  async loadGroup(groupId) {
    return this.#loadRecord(this.#groupPath(normalizeId(groupId, 'groupId')));
  }

  async listGroups() {
    return (await listJsonRecords(this.#dir(OPS_GROUP_RECORDS_DIR)))
      .map(normalizeLoadedOpsGroup)
      .sort(compareGroups)
      .map(clone);
  }

  async saveGroupItem(input = {}) {
    const groupId = normalizeId(input.groupId, 'groupId');
    const group = await this.loadGroup(groupId);
    if (!group) throw new Error(`ops group not found: ${groupId}`);
    const existing = input.id ? await this.loadGroupItem(input.id) : null;
    const item = normalizeOpsGroupItem({ ...input, groupId }, { now: this.now(), existing });
    await writeJson(this.#itemPath(item.id), item);
    return clone(item);
  }

  async loadGroupItem(itemId) {
    return this.#loadRecord(this.#itemPath(normalizeId(itemId, 'itemId')));
  }

  async listGroupItems(groupId) {
    const normalizedGroupId = groupId ? normalizeId(groupId, 'groupId') : undefined;
    return (await listJsonRecords(this.#dir(OPS_GROUP_ITEMS_DIR)))
      .map(normalizeLoadedOpsGroupItem)
      .filter((item) => !normalizedGroupId || item.groupId === normalizedGroupId)
      .sort(compareGroupItems)
      .map(clone);
  }

  async recordGroupItemCompletion(input = {}) {
    const groupId = normalizeId(input.groupId, 'groupId');
    const itemId = normalizeId(input.itemId, 'itemId');
    const [group, item] = await Promise.all([
      this.loadGroup(groupId),
      this.loadGroupItem(itemId),
    ]);
    if (!group) throw new Error(`ops group not found: ${groupId}`);
    if (!item || item.groupId !== groupId) {
      throw new Error(`ops group item not found for group ${groupId}: ${itemId}`);
    }

    const completion = normalizeOpsCompletion(input, { now: this.now(), groupId, itemId });
    const existing = await this.loadCompletion(completion.id);
    if (existing) return clone(existing);

    await writeJson(this.#completionPath(completion.id), completion);
    return clone(completion);
  }

  async loadCompletion(completionId) {
    return this.#loadRecord(this.#completionPath(normalizeId(completionId, 'completionId')));
  }

  async listCompletions(input = {}) {
    const groupId = input.groupId ? normalizeId(input.groupId, 'groupId') : undefined;
    const itemId = input.itemId ? normalizeId(input.itemId, 'itemId') : undefined;
    const date = input.date ? dayKey(input.date) : undefined;
    const blockId = input.blockId ? normalizeBlockId(input.blockId) : undefined;

    return (await listJsonRecords(this.#dir(OPS_COMPLETIONS_DIR)))
      .map(normalizeLoadedOpsCompletion)
      .filter((completion) =>
        (!groupId || completion.groupId === groupId) &&
        (!itemId || completion.itemId === itemId) &&
        (!date || completion.date === date) &&
        (!blockId || completion.blockId === blockId))
      .sort(compareCompletions)
      .map(clone);
  }

  async listOpsGroupChecklists(input = {}) {
    const date = dayKey(input.date ?? this.now());
    const groups = (await this.listGroups()).filter((group) => group.active);
    const [items, completions] = await Promise.all([
      this.listGroupItems(),
      this.listCompletions({ date }),
    ]);
    const completionsByItem = new Map(completions.map((completion) => [completion.itemId, completion]));

    return groups
      .map((group) => {
        const groupItems = items
          .filter((item) => item.groupId === group.id && item.active)
          .map((item) => itemWithCompletion(item, completionsByItem.get(item.id)));
        return { ...group, items: groupItems };
      })
      .filter((group) => group.items.length > 0)
      .sort(compareGroups)
      .map(deepFreeze);
  }

  async addAdminItem(input = {}) {
    const now = this.now();
    const item = normalizeAdminItem(input, { now });
    const existing = await this.loadAdminItem(item.id);
    if (existing) {
      return { item: clone(existing), streamEntry: null, created: false };
    }

    await writeJson(this.#adminItemPath(item.id), item);
    const streamEntry = await this.#appendAdminStreamEntry({
      action: 'add',
      item,
      eventAt: item.createdAt,
      after: item,
      source: input.source,
    });
    return { item: clone(item), streamEntry, created: true };
  }

  async rescheduleAdminItem(input = {}) {
    const itemId = normalizeId(input.itemId ?? input.id, 'itemId');
    const existing = await this.loadAdminItem(itemId);
    if (!existing) throw new Error(`admin item not found: ${itemId}`);
    if (existing.status === 'complete') throw new Error(`admin item already complete: ${itemId}`);

    const remindAt = normalizeOptionalIso(input.remindAt ?? input.remindDate, 'remindAt');
    const dueAt = normalizeOptionalIso(input.dueAt ?? input.dueDate, 'dueAt');
    if (!remindAt && !dueAt) throw new Error('remindAt or dueAt is required');

    const now = iso(this.now());
    const updated = {
      ...existing,
      remindAt: remindAt ?? existing.remindAt,
      dueAt: dueAt ?? existing.dueAt,
      updatedAt: now,
    };
    await writeJson(this.#adminItemPath(updated.id), updated);
    const streamEntry = await this.#appendAdminStreamEntry({
      action: 'reschedule',
      item: updated,
      eventAt: now,
      before: existing,
      after: updated,
      source: input.source,
    });
    return { item: clone(updated), streamEntry };
  }

  async completeAdminItem(input = {}) {
    const itemId = normalizeId(input.itemId ?? input.id, 'itemId');
    const existing = await this.loadAdminItem(itemId);
    if (!existing) throw new Error(`admin item not found: ${itemId}`);
    if (existing.status === 'complete') {
      return { item: clone(existing), streamEntry: null, completed: false };
    }

    const now = iso(input.completedAt ?? this.now());
    const updated = {
      ...existing,
      status: 'complete',
      completedAt: now,
      updatedAt: now,
    };
    await writeJson(this.#adminItemPath(updated.id), updated);
    const streamEntry = await this.#appendAdminStreamEntry({
      action: 'complete',
      item: updated,
      eventAt: now,
      before: existing,
      after: updated,
      source: input.source,
    });
    return { item: clone(updated), streamEntry, completed: true };
  }

  async loadAdminItem(itemId) {
    return this.#loadRecord(this.#adminItemPath(normalizeId(itemId, 'itemId')));
  }

  async listAdminItems(input = {}) {
    const status = optionalString(input.status);
    if (status && !ADMIN_STATUSES.includes(status)) throw new Error(`invalid admin item status: ${status}`);
    return (await listJsonRecords(this.#dir(ADMIN_ITEMS_DIR)))
      .map(normalizeLoadedAdminItem)
      .filter((item) => !status || item.status === status)
      .sort(compareAdminItems)
      .map(clone);
  }

  async listAdminStreamEntries() {
    return (await listJsonRecords(this.#dir(ADMIN_STREAM_DIR)))
      .map(normalizeLoadedAdminStreamEntry)
      .sort(compareAdminStreamEntries)
      .map(clone);
  }

  async #appendAdminStreamEntry(input) {
    const entry = normalizeAdminStreamEntry(input);
    await writeJson(this.#streamPath(entry.id), entry);
    return clone(entry);
  }

  async #loadRecord(file) {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  #groupPath(groupId) {
    return path.join(this.#dir(OPS_GROUP_RECORDS_DIR), `${groupId}.json`);
  }

  #itemPath(itemId) {
    return path.join(this.#dir(OPS_GROUP_ITEMS_DIR), `${itemId}.json`);
  }

  #completionPath(completionId) {
    return path.join(this.#dir(OPS_COMPLETIONS_DIR), `${completionId}.json`);
  }

  #adminItemPath(itemId) {
    return path.join(this.#dir(ADMIN_ITEMS_DIR), `${itemId}.json`);
  }

  #streamPath(entryId) {
    return path.join(this.#dir(ADMIN_STREAM_DIR), `${entryId}.json`);
  }

  #dir(relativePath) {
    return path.join(this.dataDir, relativePath);
  }
}

export async function executeAdminTriageTool(toolId, args = {}, context = {}) {
  if (!ADMIN_TRIAGE_TOOLS.includes(toolId)) {
    return Object.freeze({ ok: false, reason: 'unknown_admin_tool' });
  }

  const store = context.opsStore ?? createOpsGroupStore({
    dataDir: context.dataDir,
    now: context.now,
  });
  const base = {
    sensitive: true,
    sensitivity: 'sensitive',
    frontierExcluded: true,
    provenance: ['admin', 'k-triage'],
  };

  try {
    const result = await runAdminTool(store, toolId, args);
    const entry = result.streamEntry;
    return Object.freeze({
      ok: true,
      output: formatAdminToolOutput(toolId, result),
      ...base,
      artifacts: Object.freeze({
        admin: stripUndefined({
          item: result.item,
          streamEntry: entry,
          created: result.created,
          completed: result.completed,
        }),
      }),
    });
  } catch (error) {
    return Object.freeze({
      ok: false,
      reason: adminToolErrorReason(error),
      ...base,
    });
  }
}

export function formatAdminToolOutput(toolId, result = {}) {
  const item = result.item ?? {};
  const entry = result.streamEntry;
  const action = toolId.replace(/^admin\./, '');
  const lines = [
    `admin.${action}: ${entry ? 'streamed' : 'no-op'}`,
    `item: ${item.id ?? '?'}`,
    `title: ${item.title ?? ''}`,
    `status: ${item.status ?? 'unknown'}`,
  ];
  if (item.remindAt) lines.push(`remindAt: ${item.remindAt}`);
  if (item.dueAt) lines.push(`dueAt: ${item.dueAt}`);
  if (entry) lines.push(`streamEntry: ${entry.id}`);
  return lines.join('\n');
}

function runAdminTool(store, toolId, args) {
  if (toolId === 'admin.add') return store.addAdminItem(args);
  if (toolId === 'admin.reschedule') return store.rescheduleAdminItem(args);
  if (toolId === 'admin.complete') return store.completeAdminItem(args);
  throw new Error('unknown_admin_tool');
}

function normalizeOpsGroup(input, { now, existing } = {}) {
  const title = boundedText(input.title ?? input.name, 'title', TITLE_MAX_CHARS);
  const schedule = optionalString(input.schedule ?? existing?.schedule ?? 'daily') ?? 'daily';
  const id = normalizeOptionalId(input.id) ?? opsId('opsg', [title, schedule]);
  return deepFreeze(stripUndefined({
    id,
    kind: 'OpsGroup',
    schemaVersion: SCHEMA_VERSION,
    title,
    schedule,
    targetBlockId: optionalString(input.targetBlockId ?? existing?.targetBlockId),
    active: input.active ?? existing?.active ?? true,
    createdAt: existing?.createdAt ?? iso(now),
    updatedAt: iso(now),
  }));
}

function normalizeLoadedOpsGroup(value) {
  if (!isPlainObject(value)) throw new Error('ops group record must be an object');
  return normalizeOpsGroup(value, {
    now: value.updatedAt ?? value.createdAt ?? new Date(),
    existing: value,
  });
}

function normalizeOpsGroupItem(input, { now, existing } = {}) {
  const groupId = normalizeId(input.groupId, 'groupId');
  const title = boundedText(input.title ?? input.name, 'title', TITLE_MAX_CHARS);
  const sortOrder = finiteSortOrder(input.sortOrder ?? existing?.sortOrder ?? 0);
  const id = normalizeOptionalId(input.id) ?? opsId('opsi', [groupId, title, sortOrder]);
  return deepFreeze(stripUndefined({
    id,
    kind: 'OpsGroupItem',
    schemaVersion: SCHEMA_VERSION,
    groupId,
    title,
    sortOrder,
    active: input.active ?? existing?.active ?? true,
    createdAt: existing?.createdAt ?? iso(now),
    updatedAt: iso(now),
  }));
}

function normalizeLoadedOpsGroupItem(value) {
  if (!isPlainObject(value)) throw new Error('ops group item record must be an object');
  return normalizeOpsGroupItem(value, {
    now: value.updatedAt ?? value.createdAt ?? new Date(),
    existing: value,
  });
}

function normalizeOpsCompletion(input, { now, groupId, itemId } = {}) {
  const blockId = normalizeBlockId(input.blockId);
  const date = dayKey(input.date ?? now);
  const status = optionalString(input.status ?? 'done') ?? 'done';
  if (!OPS_COMPLETION_STATUSES.includes(status)) throw new Error(`invalid ops completion status: ${status}`);
  const id = normalizeOptionalId(input.id) ?? opsId('opsc', [groupId, itemId, blockId, date, status]);
  return deepFreeze(stripUndefined({
    id,
    kind: 'OpsCompletion',
    schemaVersion: SCHEMA_VERSION,
    groupId,
    itemId,
    blockId,
    date,
    status,
    completedAt: iso(input.completedAt ?? now),
    note: boundedOptionalText(input.note, 'note', NOTE_MAX_CHARS),
  }));
}

function normalizeLoadedOpsCompletion(value) {
  if (!isPlainObject(value)) throw new Error('ops completion record must be an object');
  const completion = {
    id: normalizeId(value.id, 'completionId'),
    kind: 'OpsCompletion',
    schemaVersion: SCHEMA_VERSION,
    groupId: normalizeId(value.groupId, 'groupId'),
    itemId: normalizeId(value.itemId, 'itemId'),
    blockId: normalizeBlockId(value.blockId),
    date: dayKey(value.date),
    status: optionalString(value.status),
    completedAt: iso(value.completedAt),
    note: boundedOptionalText(value.note, 'note', NOTE_MAX_CHARS),
  };
  if (!OPS_COMPLETION_STATUSES.includes(completion.status)) {
    throw new Error(`invalid ops completion status: ${completion.status}`);
  }
  return deepFreeze(stripUndefined(completion));
}

function normalizeAdminItem(input, { now }) {
  const title = boundedText(input.title ?? input.summary, 'title', TITLE_MAX_CHARS);
  const type = normalizeEnum(input.type ?? 'RegularQueue', ADMIN_TYPES, 'type');
  const effort = normalizeEnum(input.effort ?? 'Quick', ADMIN_EFFORTS, 'effort');
  const remindAt = normalizeOptionalIso(input.remindAt ?? input.remindDate, 'remindAt');
  const dueAt = normalizeOptionalIso(input.dueAt ?? input.dueDate, 'dueAt');
  const createdAt = iso(input.createdAt ?? now);
  const id = normalizeOptionalId(input.id ?? input.itemId) ??
    opsId('adm', [title, type, effort, remindAt ?? '', dueAt ?? '', createdAt]);
  return deepFreeze(stripUndefined({
    id,
    kind: 'AdminBandish',
    schemaVersion: SCHEMA_VERSION,
    title,
    type,
    effort,
    remindAt,
    dueAt,
    status: 'open',
    completedAt: null,
    note: boundedOptionalText(input.note, 'note', NOTE_MAX_CHARS),
    createdAt,
    updatedAt: iso(now),
    provenance: {
      surface: optionalString(input.surface ?? input.source) ?? 'k-triage',
      lane: 'deliberate',
    },
  }));
}

function normalizeLoadedAdminItem(value) {
  if (!isPlainObject(value)) throw new Error('admin item record must be an object');
  const status = normalizeEnum(value.status ?? 'open', ADMIN_STATUSES, 'status');
  return deepFreeze(stripUndefined({
    id: normalizeId(value.id, 'itemId'),
    kind: 'AdminBandish',
    schemaVersion: SCHEMA_VERSION,
    title: boundedText(value.title, 'title', TITLE_MAX_CHARS),
    type: normalizeEnum(value.type, ADMIN_TYPES, 'type'),
    effort: normalizeEnum(value.effort, ADMIN_EFFORTS, 'effort'),
    remindAt: normalizeOptionalIso(value.remindAt, 'remindAt'),
    dueAt: normalizeOptionalIso(value.dueAt, 'dueAt'),
    status,
    completedAt: status === 'complete' ? normalizeOptionalIso(value.completedAt, 'completedAt') : null,
    note: boundedOptionalText(value.note, 'note', NOTE_MAX_CHARS),
    createdAt: iso(value.createdAt),
    updatedAt: iso(value.updatedAt ?? value.createdAt),
    provenance: isPlainObject(value.provenance)
      ? {
          surface: optionalString(value.provenance.surface) ?? 'k-triage',
          lane: optionalString(value.provenance.lane) ?? 'deliberate',
        }
      : { surface: 'k-triage', lane: 'deliberate' },
  }));
}

function normalizeAdminStreamEntry(input) {
  const action = normalizeEnum(input.action, ['add', 'reschedule', 'complete'], 'action');
  const item = isPlainObject(input.item) ? input.item : {};
  const itemId = normalizeId(item.id, 'itemId');
  const eventAt = iso(input.eventAt);
  const id = opsId('adse', [action, itemId, eventAt]);
  return deepFreeze(stripUndefined({
    id,
    kind: 'AdminStreamEntry',
    schemaVersion: SCHEMA_VERSION,
    action,
    itemId,
    title: boundedText(item.title, 'title', TITLE_MAX_CHARS),
    eventAt,
    source: optionalString(input.source) ?? 'k-triage-tool',
    text: adminStreamText(action, item),
    before: compactAdminItem(input.before),
    after: compactAdminItem(input.after ?? item),
  }));
}

function normalizeLoadedAdminStreamEntry(value) {
  if (!isPlainObject(value)) throw new Error('admin stream entry record must be an object');
  return deepFreeze(stripUndefined({
    id: normalizeId(value.id, 'streamEntryId'),
    kind: 'AdminStreamEntry',
    schemaVersion: SCHEMA_VERSION,
    action: normalizeEnum(value.action, ['add', 'reschedule', 'complete'], 'action'),
    itemId: normalizeId(value.itemId, 'itemId'),
    title: boundedText(value.title, 'title', TITLE_MAX_CHARS),
    eventAt: iso(value.eventAt),
    source: optionalString(value.source) ?? 'k-triage-tool',
    text: boundedText(value.text, 'text', TITLE_MAX_CHARS + 80),
    before: compactAdminItem(value.before),
    after: compactAdminItem(value.after),
  }));
}

function compactAdminItem(item) {
  if (!isPlainObject(item)) return undefined;
  return stripUndefined({
    id: optionalString(item.id),
    title: optionalString(item.title),
    type: optionalString(item.type),
    effort: optionalString(item.effort),
    remindAt: optionalString(item.remindAt),
    dueAt: optionalString(item.dueAt),
    status: optionalString(item.status),
    completedAt: optionalString(item.completedAt),
  });
}

function adminStreamText(action, item) {
  if (action === 'add') return `added admin item: ${item.title}`;
  if (action === 'reschedule') return `rescheduled admin item: ${item.title}`;
  return `completed admin item: ${item.title}`;
}

function itemWithCompletion(item, completion) {
  return stripUndefined({
    ...item,
    status: completion ? completion.status : 'pending',
    completionBlockId: completion?.blockId,
    completionId: completion?.id,
    completedAt: completion?.completedAt,
  });
}

function compareGroups(a, b) {
  return a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
}

function compareGroupItems(a, b) {
  return (
    a.groupId.localeCompare(b.groupId) ||
    a.sortOrder - b.sortOrder ||
    a.title.localeCompare(b.title) ||
    a.id.localeCompare(b.id)
  );
}

function compareCompletions(a, b) {
  return (
    a.date.localeCompare(b.date) ||
    a.blockId.localeCompare(b.blockId) ||
    a.groupId.localeCompare(b.groupId) ||
    a.itemId.localeCompare(b.itemId)
  );
}

function compareAdminItems(a, b) {
  return (
    nullableCompare(a.remindAt, b.remindAt) ||
    nullableCompare(a.dueAt, b.dueAt) ||
    effortRank(a.effort) - effortRank(b.effort) ||
    a.createdAt.localeCompare(b.createdAt) ||
    a.id.localeCompare(b.id)
  );
}

function compareAdminStreamEntries(a, b) {
  return a.eventAt.localeCompare(b.eventAt) || a.id.localeCompare(b.id);
}

function nullableCompare(a, b) {
  const left = optionalString(a) ?? '9999-12-31T23:59:59.999Z';
  const right = optionalString(b) ?? '9999-12-31T23:59:59.999Z';
  return left.localeCompare(right);
}

function effortRank(effort) {
  return ADMIN_EFFORTS.indexOf(effort);
}

async function listJsonRecords(dir) {
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const records = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    records.push(JSON.parse(await fs.readFile(path.join(dir, entry.name), 'utf8')));
  }
  return records;
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, file);
}

function opsId(prefix, parts) {
  return `${prefix}_${createHash('sha256').update(stableJson(parts)).digest('hex').slice(0, 24)}`;
}

function normalizeOptionalId(value) {
  const id = optionalString(value);
  return id ? normalizeId(id, 'id') : undefined;
}

function normalizeId(value, label) {
  const id = requiredString(value, label);
  if (!ID_PATTERN.test(id)) throw new Error(`${label} has invalid id shape`);
  return id;
}

function normalizeBlockId(value) {
  return requiredString(value, 'blockId');
}

function normalizeEnum(value, allowed, label) {
  const normalized = requiredString(value, label);
  if (!allowed.includes(normalized)) throw new Error(`invalid ${label}: ${normalized}`);
  return normalized;
}

function boundedText(value, label, maxChars) {
  const text = requiredString(value, label);
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

function boundedOptionalText(value, label, maxChars) {
  const text = optionalString(value);
  if (!text) return undefined;
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

function finiteSortOrder(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error('sortOrder must be finite');
  return number;
}

function normalizeOptionalIso(value, label) {
  if (value === undefined || value === null || value === '') return undefined;
  return iso(value, label);
}

function iso(value, label = 'date') {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${label} must be a valid date`);
  return date.toISOString();
}

function dayKey(value) {
  return iso(value, 'date').slice(0, 10);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function adminToolErrorReason(error) {
  const message = optionalString(error?.message) ?? '';
  if (/not found/.test(message)) return 'not_found';
  if (/already complete/.test(message)) return 'already_complete';
  if (/required/.test(message)) return 'invalid_args';
  if (/invalid/.test(message)) return 'invalid_args';
  return 'admin_tool_failed';
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object') return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function normalizeNow(value) {
  if (typeof value === 'function') return value;
  if (value !== undefined && value !== null) return () => value;
  return () => new Date();
}
