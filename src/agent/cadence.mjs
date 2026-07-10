import {
  isPlainObject,
  optionalString,
  requiredString,
  stripUndefined,
} from '../substrate.mjs';

export const CADENCE_RINGS = Object.freeze(['core', 'middle', 'outer']);
export const ATTENTION_MODES = Object.freeze([
  'diverge',
  'converge',
  'breakthrough',
  'operative',
  'physical',
  'restore',
]);
export const CADENCE_BANDISH_TYPES = Object.freeze([
  'work',
  'meal',
  'sleep',
  'meditation',
  'workout',
  'routine',
  'ops',
]);

const OPS_BLOCK_TYPES = new Set(['ops', 'admin-ops', 'operative-ops']);
const ADMIN_PROJECTION_KEYS = Object.freeze([
  'adminItems',
  'adminChecklist',
  'opsChecklist',
  'checklist',
]);

export function populateCadenceOpsBlocks(input = {}) {
  const blocks = Array.isArray(input.blocks) ? input.blocks : [];
  const opsGroups = Array.isArray(input.opsGroups) ? input.opsGroups : [];
  const adminItems = Array.isArray(input.adminItems) ? input.adminItems : [];
  const stripped = [];
  const populated = [];

  for (const block of blocks) {
    const normalized = normalizeCadenceBlock(block);
    if (!isCadenceOpsBlock(normalized)) {
      const clean = stripAdminProjection(normalized);
      if (clean !== normalized) stripped.push(normalized.id);
      populated.push(clean);
      continue;
    }

    const opsChecklist = buildOpsChecklist({
      block: normalized,
      opsGroups,
      adminItems,
    });
    populated.push({
      ...stripAdminProjection(normalized),
      opsChecklist,
      checklist: flattenOpsChecklist(opsChecklist),
    });
  }

  return deepFreeze({
    blocks: populated,
    strippedBlockIds: stripped,
  });
}

export function isCadenceOpsBlock(block) {
  if (!isPlainObject(block)) return false;
  const ring = maybeNormalizeRing(block.ring ?? block.Ring);
  const attentionMode = maybeNormalizeAttentionMode(block.attentionMode ?? block.mode ?? block.AttentionMode);
  if (ring !== 'outer' || attentionMode !== 'operative') return false;

  const blockType = optionalString(block.blockType ?? block.type ?? block.kind);
  return (
    block.opsBlock === true ||
    block.isOpsBlock === true ||
    block.ops === true ||
    OPS_BLOCK_TYPES.has(blockType ?? '')
  );
}

export function assertCadenceOpsBlock(block) {
  const normalized = normalizeCadenceBlock(block);
  const ring = normalizeRing(normalized.ring);
  if (ring === 'core' || ring === 'middle') {
    throw new Error(`admin ops checklist refused on ${ring}-ring cadence block`);
  }
  if (!isCadenceOpsBlock(normalized)) {
    throw new Error('admin ops checklist requires an outer operative ops block');
  }
  return normalized;
}

export function stripAdminProjection(block) {
  if (!isPlainObject(block)) return block;
  let changed = false;
  const clean = { ...block };
  for (const key of ADMIN_PROJECTION_KEYS) {
    if (key in clean) {
      delete clean[key];
      changed = true;
    }
  }
  return changed ? clean : block;
}

function normalizeCadenceBlock(block) {
  if (!isPlainObject(block)) throw new Error('cadence block must be an object');
  const id = requiredString(block.id ?? block.blockId, 'block.id');
  return {
    ...block,
    id,
    ring: normalizeRing(block.ring ?? block.Ring),
    attentionMode: normalizeAttentionMode(block.attentionMode ?? block.mode ?? block.AttentionMode),
  };
}

function buildOpsChecklist({ block, opsGroups, adminItems }) {
  const groups = opsGroups
    .filter((group) => groupAppliesToBlock(group, block))
    .map((group) => projectOpsGroup(group, block))
    .filter((group) => group.items.length > 0);
  const scheduledAdminItems = adminItems
    .filter((item) => optionalString(item?.status ?? 'open') === 'open')
    .map(projectAdminItem);

  return stripUndefined({
    kind: 'cadence.ops',
    blockId: block.id,
    groups,
    adminItems: scheduledAdminItems,
  });
}

function groupAppliesToBlock(group, block) {
  const targetBlockId = optionalString(group?.targetBlockId);
  return !targetBlockId || targetBlockId === block.id;
}

function projectOpsGroup(group, block) {
  const items = Array.isArray(group.items) ? group.items : [];
  return stripUndefined({
    id: optionalString(group.id),
    title: optionalString(group.title),
    items: items
      .filter((item) => item?.active !== false)
      .map((item) => projectOpsGroupItem(item, block)),
  });
}

function projectOpsGroupItem(item, block) {
  const completionBlockId = optionalString(item.completionBlockId);
  const completionApplies = !completionBlockId || completionBlockId === block.id;
  return stripUndefined({
    id: optionalString(item.id),
    title: optionalString(item.title),
    status: completionApplies ? optionalString(item.status ?? 'pending') : 'pending',
    completionId: completionApplies ? optionalString(item.completionId) : undefined,
    completedAt: completionApplies ? optionalString(item.completedAt) : undefined,
  });
}

function projectAdminItem(item) {
  return stripUndefined({
    id: optionalString(item.id),
    title: optionalString(item.title),
    type: optionalString(item.type),
    effort: optionalString(item.effort),
    remindAt: optionalString(item.remindAt),
    dueAt: optionalString(item.dueAt),
  });
}

function flattenOpsChecklist(opsChecklist) {
  const entries = [];
  for (const group of opsChecklist.groups ?? []) {
    for (const item of group.items ?? []) {
      const id = optionalString(item.id);
      const title = optionalString(item.title);
      if (!id || !title) continue;
      entries.push({
        id,
        title,
        done: item.status === 'done',
      });
    }
  }

  for (const item of opsChecklist.adminItems ?? []) {
    const id = optionalString(item.id);
    const title = optionalString(item.title);
    if (!id || !title) continue;
    entries.push({
      id,
      title,
      done: false,
    });
  }

  return entries;
}

function normalizeRing(value) {
  const ring = requiredString(value, 'ring').toLowerCase();
  if (!CADENCE_RINGS.includes(ring)) throw new Error(`invalid cadence ring: ${ring}`);
  return ring;
}

function maybeNormalizeRing(value) {
  try {
    return normalizeRing(value);
  } catch {
    return undefined;
  }
}

function normalizeAttentionMode(value) {
  const mode = requiredString(value, 'attentionMode').toLowerCase();
  if (!ATTENTION_MODES.includes(mode)) throw new Error(`invalid attention mode: ${mode}`);
  return mode;
}

function maybeNormalizeAttentionMode(value) {
  try {
    return normalizeAttentionMode(value);
  } catch {
    return undefined;
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object') return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
