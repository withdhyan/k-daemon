import { createHash } from 'node:crypto';

import {
  isPlainObject,
  optionalString,
  requiredString,
  stripUndefined,
} from '../substrate.mjs';
import { classifyProvenance } from './sensitivity.mjs';

export const VIEW_TYPES = Object.freeze([
  'generic.card',
  'generic.table',
  'generic.chart',
  'generic.text',
  'k0.decision',
  'k0.provenance',
  'k0.claim',
  'k0.change',
  'k0.eval_score',
  'loop.evidence',
  'preview.file',
  'preview.web',
  'preview.tool',
  'build.status',
  'build.card',
]);

export const DEFAULT_MAX_DEPTH = 6;
export const VIEW_PACKET_TEXT_MAX_CHARS = 4_000;
export const VIEW_PACKET_FIELD_STRING_MAX_CHARS = 1_000;
export const VIEW_PACKET_FIELDS_JSON_MAX_CHARS = 16_000;

export const FRONTIER_INCLUDED_SURFACES = Object.freeze([
  'public',
  'web',
  'tool',
  'system',
  'internal',
]);

export const FRONTIER_EXCLUDED_SURFACES = Object.freeze([
  'genomictrait',
  'genome',
  'genomic',
  'biomarker',
  'verbatim-chat',
  'verbatimchat',
  'body',
  'eeg',
  'attention',
  'mind-surface',
  'mindsurface',
  'mind-content',
  'mindcontent',
  'idea-atom',
  'ideaatom',
  'self-pattern',
  'selfpattern',
  'exposure',
  'substrate',
  'recommendation',
  'decision',
  'life-context',
  'lifecontext',
  'founder',
  'personal',
  'ios',
  'chrome',
]);

const VIEW_TYPE_SET = new Set(VIEW_TYPES);
const FIELD_ALIASES = Object.freeze([
  'status',
  'plane',
  'subject',
  'contradiction_count',
  'rollback_ref',
]);
const ID_PATTERN = /^[0-9a-f]{24}$/;
const PATCH_OP_SET = 'set';
const PATCH_OP_APPEND_CHILD = 'append_child';
const PATCH_OP_FLIP = 'flip';

export const VIEW_PACKET_PATCH_OPS = Object.freeze([
  PATCH_OP_SET,
  PATCH_OP_APPEND_CHILD,
  PATCH_OP_FLIP,
]);

const PATCH_SET_FIELDS = Object.freeze([
  'text',
  'fields',
  'action',
  'score',
  'evidence',
  'siblings',
  'confidence',
  'surfaceDecision',
]);
const PATCH_FLIP_FIELDS = Object.freeze([
  'viewType',
  'fields.status',
]);

export function buildViewPacket(input, options = {}) {
  const maxDepth = maxDepthOption(options.maxDepth);
  return buildPacket(input, {
    maxDepth,
    depth: 1,
    ancestors: new WeakSet(),
  });
}

export function validateViewPacket(packet, options = {}) {
  const maxDepth = maxDepthOption(options.maxDepth);
  validatePacket(packet, {
    maxDepth,
    depth: 1,
    ancestors: new WeakSet(),
  });
  return packet;
}

export function validatePacketPatch(patch, options = {}) {
  normalizePacketPatch(patch, options);
  return patch;
}


// Bound bulky packet fields under the fields-JSON validator cap. Mind outputs
// on the enriched corpus overflowed twice (2026-07-05) from two call sites;
// this is the single canonical bound — import it, never re-copy.
export function boundPacketFields(fields, options = {}) {
  const capChars = options.capChars ?? 15_000;
  const bounded = { ...fields };
  const arrayCaps = [
    ['considerations', 24], ['siblings', 24], ['evidenceIds', 40],
    ['atomIds', 40], ['sourceAtomIds', 40], ['openAtomIds', 40], ['conversationIds', 24],
  ];
  for (const [key, cap] of arrayCaps) {
    if (Array.isArray(bounded[key]) && bounded[key].length > cap) bounded[key] = bounded[key].slice(0, cap);
  }
  let shrink = 0;
  while (JSON.stringify(bounded).length > capChars && shrink < 6) {
    shrink += 1;
    for (const [key] of arrayCaps) {
      if (Array.isArray(bounded[key]) && bounded[key].length > 4) {
        bounded[key] = bounded[key].slice(0, Math.max(4, Math.floor(bounded[key].length / 2)));
      }
    }
    for (const [key, value] of Object.entries(bounded)) {
      if (typeof value === 'string' && value.length > 2000) bounded[key] = value.slice(0, 2000);
    }
  }
  return bounded;
}

export function buildPacketPatch(input, options = {}) {
  return deepFreeze(normalizePacketPatch(input, options));
}

export function applyPacketPatch(packet, patch, options = {}) {
  const maxDepth = maxDepthOption(options.maxDepth);
  validateViewPacket(packet, { maxDepth });
  const normalized = normalizePacketPatch(patch, { ...options, maxDepth });
  const result = applyPatchToNode(packet, normalized, { maxDepth });

  if (result.found) return result.packet;
  if (patchAlreadyApplied(packet, normalized)) return packet;

  const logger = options.logger ?? console;
  logger?.warn?.(`[cs-k] view-packet patch ignored: unknown packet id ${normalized.targetId}`);
  return packet;
}

export function isViewType(value) {
  return VIEW_TYPE_SET.has(value);
}

export function frontierExcludedForProvenance(input = {}) {
  if (input.frontierExcluded === true) return true;

  const provenance = input.provenance;
  if (!isPlainObject(provenance)) return true;

  const surface = normalizedSurface(provenance.surface);
  if (!surface) return true;
  if (FRONTIER_EXCLUDED_SURFACES.includes(surface)) return true;
  if (FRONTIER_INCLUDED_SURFACES.includes(surface)) {
    return classifyProvenance(surface) === 'sensitive';
  }

  return true;
}

function buildPacket(input, context) {
  if (!isPlainObject(input)) throw new Error('view packet input must be an object');
  if (context.depth > context.maxDepth) {
    throw new Error(`view packet exceeds max depth ${context.maxDepth}`);
  }
  if (context.ancestors.has(input)) {
    throw new Error('view packet cycle detected');
  }
  context.ancestors.add(input);

  try {
    const viewType = requiredString(input.viewType, 'viewType');
    assertViewType(viewType);
    const provenance = normalizeProvenance(input.provenance);
    const children = normalizeChildren(input.children, context);
    const fields = normalizeFields(input);
    const evidence = normalizeStringArray(input.evidence ?? input.evidence_refs, 'evidence');
    const siblings = normalizeStringArray(input.siblings, 'siblings');
    const action = normalizeAction(input.action ?? input.nextAction);
    const confidence = optionalConfidence(input.confidence, 'confidence');
    const score = optionalFiniteNumber(input.score ?? input.eval_score, 'score');
    const surfaceDecision = normalizeFieldsObject(input.surfaceDecision, 'surfaceDecision');
    const frontierExcluded = frontierExcludedForProvenance({
      provenance,
      frontierExcluded: input.frontierExcluded,
    });

    const packetWithoutId = stripUndefined({
      viewType,
      text: boundedOptionalString(input.text, 'text', VIEW_PACKET_TEXT_MAX_CHARS),
      fields,
      children,
      action,
      score,
      evidence,
      siblings,
      confidence,
      provenance,
      surfaceDecision,
      frontierExcluded,
    });
    const packet = {
      id: viewPacketId(packetWithoutId),
      ...packetWithoutId,
    };
    validateViewPacket(packet, { maxDepth: context.maxDepth });
    return deepFreeze(packet);
  } finally {
    context.ancestors.delete(input);
  }
}

function validatePacket(packet, context) {
  if (!isPlainObject(packet)) throw new Error('view packet must be an object');
  if (context.depth > context.maxDepth) {
    throw new Error(`view packet exceeds max depth ${context.maxDepth}`);
  }
  if (context.ancestors.has(packet)) {
    throw new Error('view packet cycle detected');
  }
  context.ancestors.add(packet);

  try {
    const id = requiredString(packet.id, 'id');
    if (!ID_PATTERN.test(id)) throw new Error('id must be a 24-character sha256 hex prefix');

    const viewType = requiredString(packet.viewType, 'viewType');
    assertViewType(viewType);
    normalizeProvenance(packet.provenance, { truncate: false });
    if (typeof packet.frontierExcluded !== 'boolean') {
      throw new Error('frontierExcluded must be boolean');
    }

    boundedOptionalString(packet.text, 'text', VIEW_PACKET_TEXT_MAX_CHARS, { truncate: false });
    validateFields(packet.fields, 'fields');
    validateAction(packet.action);
    optionalFiniteNumber(packet.score, 'score');
    validateStringArray(packet.evidence, 'evidence');
    validateStringArray(packet.siblings, 'siblings');
    optionalConfidence(packet.confidence, 'confidence');
    validateFields(packet.surfaceDecision, 'surfaceDecision');

    if (packet.children !== undefined) {
      if (!Array.isArray(packet.children)) throw new Error('children must be an array');
      for (const child of packet.children) {
        validatePacket(child, {
          ...context,
          depth: context.depth + 1,
        });
      }
    }

    const { id: _id, ...packetWithoutId } = packet;
    const expectedId = viewPacketId(packetWithoutId);
    if (id !== expectedId) {
      throw new Error(`id must match deterministic packet hash: expected ${expectedId}`);
    }
  } finally {
    context.ancestors.delete(packet);
  }
}

function normalizePacketPatch(patch, options = {}) {
  if (!isPlainObject(patch)) throw new Error('packet patch must be an object');
  const targetId = requiredString(
    patch.targetId ?? patch.packetId,
    'patch.targetId',
  );
  assertPacketId(targetId, 'patch.targetId');
  const resultId = boundedOptionalString(patch.resultId, 'patch.resultId', 80, { truncate: false });
  if (resultId) assertPacketId(resultId, 'patch.resultId');

  const rawOps = Array.isArray(patch.ops)
    ? patch.ops
    : patch.op
      ? [patch]
      : undefined;
  if (!Array.isArray(rawOps) || rawOps.length === 0) {
    throw new Error('patch.ops must be a non-empty array');
  }

  return stripUndefined({
    targetId,
    resultId,
    ops: rawOps.map((op, index) => normalizePatchOp(op, index, options)),
  });
}

function normalizePatchOp(raw, index, options) {
  if (!isPlainObject(raw)) throw new Error(`patch.ops[${index}] must be an object`);
  const op = normalizePatchOpName(requiredString(raw.op ?? raw.type, `patch.ops[${index}].op`));

  if (op === PATCH_OP_SET) {
    const field = normalizeSetPatchField(raw.field ?? raw.path ?? raw.key, index);
    return {
      op,
      field,
      value: normalizePatchValue(field, raw.value, `patch.ops[${index}].value`, options),
    };
  }

  if (op === PATCH_OP_APPEND_CHILD) {
    const childInput = raw.child ?? raw.value;
    if (!isPlainObject(childInput)) throw new Error(`patch.ops[${index}].child must be an object`);
    const child = typeof childInput.id === 'string'
      ? validateViewPacket(childInput, options)
      : buildViewPacket(childInput, options);
    return { op, child };
  }

  if (op === PATCH_OP_FLIP) {
    const field = normalizeFlipPatchField(raw.field ?? raw.path ?? raw.key, index);
    const value = normalizePatchValue(field, raw.value, `patch.ops[${index}].value`, options);
    return stripUndefined({
      op,
      field,
      from: raw.from === undefined
        ? undefined
        : normalizePatchValue(field, raw.from, `patch.ops[${index}].from`, options),
      value,
    });
  }

  throw new Error(`unknown packet patch op: ${op}`);
}

function normalizePatchOpName(value) {
  if (value === 'append-child' || value === 'appendChild') return PATCH_OP_APPEND_CHILD;
  if (VIEW_PACKET_PATCH_OPS.includes(value)) return value;
  throw new Error(`unknown packet patch op: ${value}`);
}

function normalizeSetPatchField(value, index) {
  const field = normalizePatchField(value, index);
  if (PATCH_SET_FIELDS.includes(field) || field.startsWith('fields.')) return field;
  throw new Error(`patch.ops[${index}].field is not settable: ${field}`);
}

function normalizeFlipPatchField(value, index) {
  const field = normalizePatchField(value, index);
  if (PATCH_FLIP_FIELDS.includes(field)) return field;
  throw new Error(`patch.ops[${index}].field is not flippable: ${field}`);
}

function normalizePatchField(value, index) {
  const field = boundedString(
    requiredString(value, `patch.ops[${index}].field`),
    `patch.ops[${index}].field`,
    160,
    { truncate: false },
  );
  if (field === 'status') return 'fields.status';
  return field;
}

function normalizePatchValue(field, value, label, options) {
  if (value === undefined) throw new Error(`${label} is required`);
  if (field === 'viewType') {
    const viewType = requiredString(value, label);
    assertViewType(viewType);
    return viewType;
  }
  if (field === 'text') {
    return boundedOptionalString(value, label, VIEW_PACKET_TEXT_MAX_CHARS, { ...options, truncate: false });
  }
  if (field === 'fields') return boundedFields(plainObject(value, label), label, { ...options, truncate: false });
  if (field.startsWith('fields.')) return boundFieldValue(value, label, { ...options, truncate: false });
  if (field === 'score') return optionalFiniteNumber(value, label);
  if (field === 'confidence') return optionalConfidence(value, label);
  if (field === 'evidence' || field === 'siblings') {
    validateStringArray(value, label);
    return value.map((item, index) => boundedString(
      requiredString(item, `${label}[${index}]`),
      `${label}[${index}]`,
      240,
      { ...options, truncate: false },
    ));
  }
  if (field === 'surfaceDecision') {
    return boundedFields(plainObject(value, label), label, { ...options, truncate: false });
  }
  if (field === 'action') {
    return buildAction(plainObject(value, label), { ...options, truncate: false });
  }
  throw new Error(`${label} cannot patch ${field}`);
}

function applyPatchToNode(node, patch, context) {
  if (node.id === patch.targetId) {
    const updated = applyPatchOpsToTarget(node, patch.ops, context);
    return { found: true, packet: updated };
  }

  if (!Array.isArray(node.children) || node.children.length === 0) {
    return { found: false, packet: node };
  }

  let found = false;
  let changed = false;
  const children = node.children.map((child) => {
    const result = applyPatchToNode(child, patch, context);
    if (!result.found) return child;
    found = true;
    if (result.packet !== child) changed = true;
    return result.packet;
  });

  if (!found) return { found: false, packet: node };
  if (!changed) return { found: true, packet: node };

  const draft = packetToInput(node);
  draft.children = children;
  const updated = buildViewPacket(draft, context);
  return {
    found: true,
    packet: samePacketContent(node, updated) ? node : updated,
  };
}

function applyPatchOpsToTarget(packet, ops, context) {
  const draft = packetToInput(packet);

  for (const op of ops) {
    if (op.op === PATCH_OP_SET) {
      setPatchField(draft, op.field, op.value);
    } else if (op.op === PATCH_OP_APPEND_CHILD) {
      const children = Array.isArray(draft.children) ? draft.children : [];
      if (!children.some((child) => child.id === op.child.id)) {
        draft.children = [...children, op.child];
      }
    } else if (op.op === PATCH_OP_FLIP) {
      const current = readPatchField(draft, op.field);
      if (
        op.from === undefined ||
        sameJsonValue(current, op.from) ||
        sameJsonValue(current, op.value)
      ) {
        setPatchField(draft, op.field, op.value);
      }
    }
  }

  const updated = buildViewPacket(draft, context);
  return samePacketContent(packet, updated) ? packet : updated;
}

function setPatchField(target, field, value) {
  if (field.startsWith('fields.')) {
    const key = field.slice('fields.'.length);
    target.fields = { ...(target.fields ?? {}), [key]: cloneJson(value) };
    return;
  }
  target[field] = cloneJson(value);
}

function readPatchField(target, field) {
  if (field.startsWith('fields.')) {
    return target.fields?.[field.slice('fields.'.length)];
  }
  return target[field];
}

function patchAlreadyApplied(packet, patch) {
  if (patch.resultId && packetContainsId(packet, patch.resultId)) return true;
  if (patchOpsAlreadyAppliedToNode(packet, patch.ops)) return true;
  return Array.isArray(packet.children) && packet.children.some((child) => patchAlreadyApplied(child, patch));
}

function patchOpsAlreadyAppliedToNode(packet, ops) {
  return ops.every((op) => {
    if (op.op === PATCH_OP_SET || op.op === PATCH_OP_FLIP) {
      return sameJsonValue(readPatchField(packet, op.field), op.value);
    }
    if (op.op === PATCH_OP_APPEND_CHILD) {
      return Array.isArray(packet.children) && packet.children.some((child) => child.id === op.child.id);
    }
    return false;
  });
}

function packetContainsId(packet, id) {
  if (packet.id === id) return true;
  return Array.isArray(packet.children) && packet.children.some((child) => packetContainsId(child, id));
}

function normalizeChildren(children, context) {
  if (children === undefined || children === null) return undefined;
  if (!Array.isArray(children)) throw new Error('children must be an array');
  return children.map((child) => buildPacket(child, {
    ...context,
    depth: context.depth + 1,
  }));
}

function normalizeFields(input) {
  const aliasFields = {};
  for (const field of FIELD_ALIASES) {
    if (input[field] !== undefined) aliasFields[field] = input[field];
  }

  const fields = input.fields === undefined || input.fields === null
    ? aliasFields
    : {
      ...aliasFields,
      ...plainObject(input.fields, 'fields'),
    };

  return Object.keys(fields).length > 0
    ? boundedFields(fields, 'fields')
    : undefined;
}

function normalizeFieldsObject(value, label) {
  if (value === undefined || value === null) return undefined;
  return boundedFields(plainObject(value, label), label);
}

function validateFields(value, label) {
  if (value === undefined || value === null) return;
  boundedFields(plainObject(value, label), label, { truncate: false });
}

function boundedFields(value, label, options = {}) {
  const bounded = boundFieldValue(value, label, options);
  const jsonLength = JSON.stringify(bounded).length;
  if (jsonLength > VIEW_PACKET_FIELDS_JSON_MAX_CHARS) {
    throw new Error(`${label} exceeds ${VIEW_PACKET_FIELDS_JSON_MAX_CHARS} JSON chars`);
  }
  return bounded;
}

function boundFieldValue(value, label, options = {}) {
  if (value === undefined) return undefined;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${label} must be finite`);
    return value;
  }
  if (typeof value === 'string') {
    return boundedString(value, label, VIEW_PACKET_FIELD_STRING_MAX_CHARS, options);
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => boundFieldValue(item, `${label}[${index}]`, options));
  }
  if (isPlainObject(value)) {
    const clean = {};
    for (const [key, child] of Object.entries(value)) {
      const childLabel = `${label}.${key}`;
      const bounded = boundFieldValue(child, childLabel, options);
      if (bounded !== undefined) {
        clean[boundedString(key, `${label} key`, 120, options)] = bounded;
      }
    }
    return clean;
  }
  throw new Error(`${label} must be JSON-serializable`);
}

function normalizeAction(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') {
    return buildAction({
      kind: 'next_action',
      target: value,
    });
  }
  return buildAction(plainObject(value, 'action'));
}

function buildAction(value, options = {}) {
  const actionId = boundedOptionalString(value.id ?? value.actionId, 'action.id', 120, options);
  const intent = boundedOptionalString(
    value.intent ?? value.intentName ?? value.name ?? value.toolId,
    'action.intent',
    120,
    options,
  );
  const action = stripUndefined({
    kind: boundedString(requiredString(value.kind ?? intent, 'action.kind'), 'action.kind', 80, options),
    target: boundedString(
      requiredString(value.target ?? actionId ?? intent, 'action.target'),
      'action.target',
      240,
      options,
    ),
    tag: boundedOptionalString(value.tag, 'action.tag', 80, options),
    id: actionId,
    intent,
    args: normalizeActionArgs(value.args ?? value.arguments, options),
  });
  assertNotUrl(action.kind, 'action.kind');
  if (action.id) assertNotUrl(action.id, 'action.id');
  if (action.intent) assertNotUrl(action.intent, 'action.intent');
  assertNotUrl(action.target, 'action.target');
  if (action.tag) assertNotUrl(action.tag, 'action.tag');
  return action;
}

function validateAction(value) {
  if (value === undefined || value === null) return;
  buildAction(plainObject(value, 'action'), { truncate: false });
}

function normalizeActionArgs(value, options = {}) {
  if (value === undefined || value === null) return undefined;
  return boundedFields(plainObject(value, 'action.args'), 'action.args', options);
}

function normalizeProvenance(value, options = {}) {
  const provenance = plainObject(value, 'provenance');
  const normalized = boundedFields(provenance, 'provenance', options);
  const surface = requiredString(normalized.surface, 'provenance.surface');
  return stripUndefined({
    ...normalized,
    surface: boundedString(surface, 'provenance.surface', 120, options),
    plane: boundedOptionalString(normalized.plane, 'provenance.plane', 120, options),
    module: boundedOptionalString(normalized.module, 'provenance.module', 120, options),
    lane: boundedOptionalString(normalized.lane, 'provenance.lane', 120, options),
  });
}

function normalizeStringArray(values, label) {
  if (values === undefined || values === null) return undefined;
  validateStringArray(values, label);
  return values.map((value, index) => (
    boundedString(requiredString(value, `${label}[${index}]`), `${label}[${index}]`, 240)
  ));
}

function validateStringArray(values, label) {
  if (values === undefined || values === null) return;
  if (!Array.isArray(values)) throw new Error(`${label} must be an array`);
  for (const [index, value] of values.entries()) {
    boundedString(
      requiredString(value, `${label}[${index}]`),
      `${label}[${index}]`,
      240,
      { truncate: false },
    );
  }
}

function optionalConfidence(value, label) {
  const number = optionalFiniteNumber(value, label);
  if (number === undefined) return undefined;
  if (number < 0 || number > 1) throw new Error(`${label} must be between 0 and 1`);
  return number;
}

function optionalFiniteNumber(value, label) {
  if (value === undefined || value === null) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${label} must be a finite number`);
  return number;
}

function boundedOptionalString(value, label, maxChars, options = {}) {
  const text = optionalString(value);
  return text === undefined ? undefined : boundedString(text, label, maxChars, options);
}

function boundedString(value, label, maxChars, options = {}) {
  const text = String(value).trim().replace(/\s+/g, ' ');
  if (!text) throw new Error(`${label} is required`);
  if (text.length > maxChars) {
    if (options.truncate === false) throw new Error(`${label} exceeds ${maxChars} chars`);
    return text.slice(0, maxChars).trimEnd();
  }
  return text;
}

function assertViewType(viewType) {
  if (!VIEW_TYPE_SET.has(viewType)) throw new Error(`unknown viewType: ${viewType}`);
}

function assertPacketId(id, label) {
  if (!ID_PATTERN.test(id)) throw new Error(`${label} must be a 24-character sha256 hex prefix`);
}

function assertNotUrl(value, label) {
  if (/^(?:[a-z][a-z0-9+.-]*:|www\.)/i.test(value)) {
    throw new Error(`${label} must be an intent target, not a URL`);
  }
}

function plainObject(value, label) {
  if (!isPlainObject(value)) throw new Error(`${label} must be an object`);
  return value;
}

function maxDepthOption(value) {
  if (value === undefined || value === null) return DEFAULT_MAX_DEPTH;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error('maxDepth must be a positive integer');
  }
  return number;
}

function normalizedSurface(value) {
  const surface = optionalString(value);
  return surface ? surface.toLowerCase() : undefined;
}

function viewPacketId(packetWithoutId) {
  return createHash('sha256')
    .update(stableJson(idMaterial(packetWithoutId)))
    .digest('hex')
    .slice(0, 24);
}

function idMaterial(packet) {
  return stripUndefined({
    viewType: packet.viewType,
    text: packet.text,
    fields: packet.fields,
    children: packet.children?.map((child) => child.id),
    action: packet.action,
    evidence: packet.evidence,
    siblings: packet.siblings,
    confidence: packet.confidence,
    provenance: packet.provenance,
    surfaceDecision: packet.surfaceDecision,
    frontierExcluded: packet.frontierExcluded,
  });
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

function samePacketContent(left, right) {
  return sameJsonValue(packetToInput(left), packetToInput(right));
}

function sameJsonValue(left, right) {
  return stableJson(left) === stableJson(right);
}

function packetToInput(packet) {
  const { id: _id, ...input } = packet;
  return cloneJson(input);
}

function cloneJson(value) {
  if (Array.isArray(value)) return value.map(cloneJson);
  if (value && typeof value === 'object') {
    const clone = {};
    for (const [key, child] of Object.entries(value)) {
      clone[key] = cloneJson(child);
    }
    return clone;
  }
  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}
