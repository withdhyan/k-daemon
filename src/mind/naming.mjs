import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  ROOT,
  iso,
  safeDataPath,
} from '../../daemon/run.mjs';
import { openRouterZdrSingleCall } from '../agent/sovereign-single-call.mjs';
import { sha256 } from '../research/embed.mjs';
import {
  isPlainObject,
  optionalString,
} from '../substrate.mjs';

const DEFAULT_DATA_DIR = path.join(ROOT, 'data');
const NAME_CACHE_DIR = path.join('mind', 'names');
const MIND_OUTPUT_RECORD_DIR = path.join('substrate', 'mind-outputs');
const IDEA_ATOM_RECORD_DIR = path.join('substrate', 'idea-atoms');
const NAME_SCHEMA_VERSION = 1;
const MAX_MODEL_NAME_CHARS = 56;
const MIN_MODEL_NAME_WORDS = 2;
const MAX_MODEL_NAME_WORDS = 6;
const DEFAULT_NAME_TIMEOUT_MS = 20_000;
const MODEL_NAME_PATTERN =
  `^(?!(?:build|review|decide|configure|ship|stage|surface|name|make|create|keep|preserve|convert|connect|relabel|rename|fix|run)(?:\\s+(?:build|review|decide|configure|ship|stage|surface|name|make|create|keep|preserve|convert|connect|relabel|rename|fix|run)){1,5}$)[A-Za-z0-9][A-Za-z0-9'&-]*(?:\\s+[A-Za-z0-9][A-Za-z0-9'&-]*){1,5}$`;

const MIND_ENTITY_NAME_TOOL = Object.freeze({
  name: 'name_mind_entity',
  description: 'Return one founder-facing noun phrase for this mind cluster.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      label: {
        type: 'string',
        minLength: 3,
        maxLength: MAX_MODEL_NAME_CHARS,
        pattern: MODEL_NAME_PATTERN,
        description:
          'A 2-6 word human noun phrase, in vocabulary present in the founder statements. ' +
          'No verbs-only labels. No glued words. No template keys.',
      },
    },
    required: ['label'],
  },
});

const NAME_SYSTEM_PROMPT = [
  'You name mind entities for K.',
  'Return exactly one tool call.',
  'Name what this cluster is actually about, not the extraction pipeline.',
  'Use the founder vocabulary present in the statements. Prefer concrete nouns.',
  'The label must be a 2-6 word human noun phrase.',
  'No verbs-only labels, no glued words, no keyword mashes, no template keys.',
  'Lowercase is preferred unless the founder vocabulary requires a proper name.',
].join('\n');

const CONNECTOR_WORDS = new Set([
  'a',
  'an',
  'and',
  'as',
  'at',
  'between',
  'for',
  'from',
  'in',
  'into',
  'of',
  'on',
  'or',
  'the',
  'to',
  'with',
  'without',
]);

const COMMON_VERBS = new Set([
  'build',
  'configure',
  'connect',
  'convert',
  'create',
  'decide',
  'fix',
  'keep',
  'make',
  'name',
  'preserve',
  'relabel',
  'rename',
  'review',
  'run',
  'ship',
  'stage',
  'surface',
]);

export async function nameMindEntity({
  statements,
  keywords,
  contentHash,
  dataDir = process.env.CS_K_DATA_DIR ?? DEFAULT_DATA_DIR,
  now = () => new Date(),
  modelCall = openRouterZdrSingleCall,
  fallbackLabel,
  logger,
  onNote,
  timeoutMs = DEFAULT_NAME_TIMEOUT_MS,
} = {}) {
  const normalizedStatements = normalizedTextList(statements);
  const normalizedKeywords = normalizedTextList(keywords);
  const fallback = fallbackMindEntityLabel({
    statements: normalizedStatements,
    keywords: normalizedKeywords,
    fallbackLabel,
  });
  const cacheHash = mindEntityNameContentHash({
    statements: normalizedStatements,
    keywords: normalizedKeywords,
    contentHash,
  });
  const knownWords = vocabularyWords(normalizedStatements, normalizedKeywords);

  const cached = await readCachedMindEntityName({
    dataDir,
    contentHash: cacheHash,
    knownWords,
  });
  if (cached) return cached;

  if (typeof modelCall !== 'function') return fallback;

  try {
    const raw = await withTimeout(() => modelCall({
      label: 'cs-k:mind:name-entity',
      task: 'mind.nameEntity',
      maxTokens: 160,
      temperature: 0,
      sensitivity: 'private-chat-or-bookmark',
      tool: MIND_ENTITY_NAME_TOOL,
      system: NAME_SYSTEM_PROMPT,
      user: JSON.stringify({
        statements: normalizedStatements.slice(0, 24),
        keywords: normalizedKeywords.slice(0, 24),
      }),
    }), timeoutMs, 'mind entity naming');
    const label = validatedMindEntityName(toolLabel(raw), { knownWords });
    if (!label) {
      noteNameFallback(onNote, logger, 'mind entity name invalid; using bounded fallback');
      return fallback;
    }

    await writeCachedMindEntityName({
      dataDir,
      contentHash: cacheHash,
      label,
      fallback,
      now,
    });
    return label;
  } catch (error) {
    noteNameFallback(onNote, logger, `mind entity naming skipped: ${error.message}`);
    return fallback;
  }
}

export function mindEntityNameContentHash({
  statements,
  keywords,
  contentHash,
} = {}) {
  const direct = optionalString(contentHash);
  if (direct && /^[a-z0-9_-]{6,128}$/i.test(direct)) return direct;

  return sha256(JSON.stringify({
    statements: normalizedTextList(statements).slice(0, 60),
    keywords: normalizedTextList(keywords).slice(0, 40),
  })).slice(0, 24);
}

export function validatedMindEntityName(value, { knownWords = new Set() } = {}) {
  const raw = optionalString(value);
  if (!raw) return null;
  if (raw.length > MAX_MODEL_NAME_CHARS) return null;
  if (/[_/\\{}[\]<>]|[a-z][A-Z]/.test(raw)) return null;

  const cleaned = raw
    .replace(/[:;,.!?]+$/g, '')
    .replace(/[^a-z0-9'& -]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  if (!cleaned || cleaned.length > MAX_MODEL_NAME_CHARS) return null;
  if (!hasSpacesOrKnownWord(cleaned, knownWords)) return null;

  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length < MIN_MODEL_NAME_WORDS || words.length > MAX_MODEL_NAME_WORDS) return null;
  if (!words.every((word) => /^[a-z0-9][a-z0-9'&-]*$/.test(word))) return null;
  if (verbsOnly(words)) return null;
  if (tooManyUnknownWords(words, knownWords)) return null;

  return words.join(' ');
}

export async function relabelMindOutputs({
  dataDir = process.env.CS_K_DATA_DIR ?? DEFAULT_DATA_DIR,
  now = () => new Date(),
  modelCall = openRouterZdrSingleCall,
  fallbackLabel,
  logger,
  onNote,
} = {}) {
  const entries = await readMindOutputEntries(dataDir);
  const atomCache = new Map();
  const mutations = [];
  let skippedCount = 0;

  for (const entry of entries) {
    const record = entry.record;
    if (!isLiveRelabelableMindOutput(record)) {
      skippedCount += 1;
      continue;
    }

    const atoms = await recordsForIds({
      dataDir,
      ids: stringList(record.atomIds),
      cache: atomCache,
      dirname: IDEA_ATOM_RECORD_DIR,
    });
    const statements = [
      ...atoms.map((atom) => atom.statement),
      record.observation,
      ...(Array.isArray(record.considerations) ? record.considerations : []),
      record.label,
    ];
    const keywords = [
      record.type,
      record.outputGroup,
      record.label,
    ];
    const nextLabel = await nameMindEntity({
      statements,
      keywords,
      contentHash: record.contentHash,
      dataDir,
      now,
      modelCall,
      fallbackLabel: (source) => boundedFallbackLabel(source, fallbackLabel),
      logger,
      onNote,
    });

    if (nextLabel === record.label) {
      skippedCount += 1;
      continue;
    }

    const updated = {
      ...record,
      label: nextLabel,
      updatedAt: iso(now),
    };
    await fs.writeFile(entry.file, `${JSON.stringify(updated, null, 2)}\n`, 'utf8');
    mutations.push({
      op: 'update',
      kind: record.kind,
      id: record.outputId ?? record.id,
      path: entry.relPath,
    });
  }

  return Object.freeze({
    kind: 'MindOutputRelabelResult',
    updatedCount: mutations.length,
    skippedCount,
    mutations: Object.freeze(mutations),
  });
}

const DECISION_RECORD_DIRS = ['decisions', 'substrate/decisions'];

// Decision records carry the candidate label in `decision`; rename it the same
// way mind outputs are renamed. Live records only (validTo null), fail-soft.
export async function relabelDecisionRecords({
  dataDir = process.env.CS_K_DATA_DIR ?? DEFAULT_DATA_DIR,
  now = () => new Date(),
  modelCall = openRouterZdrSingleCall,
  fallbackLabel,
  logger,
  onNote,
} = {}) {
  const mutations = [];
  let skippedCount = 0;
  for (const dirname of DECISION_RECORD_DIRS) {
    const dir = path.join(dataDir, dirname);
    let files = [];
    try {
      files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json'));
    } catch { continue; }
    for (const file of files) {
      const full = path.join(dir, file);
      let record;
      try { record = JSON.parse(await fs.readFile(full, 'utf8')); } catch { skippedCount += 1; continue; }
      const label = optionalString(record?.decision);
      if (!label || record?.validTo) { skippedCount += 1; continue; }
      const statements = [record.summary, record.reason, record.recommended, record.theme, label];
      const nextLabel = await nameMindEntity({
        statements,
        keywords: [record.tag, record.station, label],
        contentHash: `decision:${file}`,
        dataDir,
        now,
        modelCall,
        fallbackLabel: (source) => boundedFallbackLabel(source, fallbackLabel),
        logger,
        onNote,
      });
      if (!nextLabel || nextLabel === label) { skippedCount += 1; continue; }
      const updated = { ...record, decision: nextLabel, decisionLabelSource: 'model-named', updatedAt: iso(now) };
      await fs.writeFile(full, `${JSON.stringify(updated, null, 2)}\n`, 'utf8');
      mutations.push({ op: 'update', kind: record.kind, id: file, path: `${dirname}/${file}` });
    }
  }
  return Object.freeze({
    kind: 'DecisionRelabelResult',
    updatedCount: mutations.length,
    skippedCount,
    mutations: Object.freeze(mutations),
  });
}


function fallbackMindEntityLabel({ statements, keywords, fallbackLabel }) {
  return boundedFallbackLabel(firstPresent([
    ...normalizedTextList(keywords),
    ...normalizedTextList(statements),
    'Untitled idea',
  ]), fallbackLabel);
}

function boundedFallbackLabel(source, fallbackLabel) {
  if (typeof fallbackLabel === 'function') {
    return optionalString(fallbackLabel(source)) ?? 'Untitled idea';
  }
  const explicit = optionalString(fallbackLabel);
  if (explicit) return explicit;
  return fallbackBound(source);
}

function fallbackBound(source) {
  const words = String(source ?? 'Untitled idea')
    .replace(/https?:\/\/\S+/g, '')
    .split(/\s+/)
    .map((word) => word.replace(/[^a-z0-9'-]/gi, ''))
    .filter(Boolean)
    .slice(0, 8);
  return words.join(' ').slice(0, 80).trim() || 'Untitled idea';
}

async function readCachedMindEntityName({ dataDir, contentHash, knownWords }) {
  try {
    const file = nameCachePath(dataDir, contentHash);
    const cached = JSON.parse(await fs.readFile(file, 'utf8'));
    return validatedMindEntityName(cached?.label, { knownWords });
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    return null;
  }
}

async function writeCachedMindEntityName({
  dataDir,
  contentHash,
  label,
  fallback,
  now,
}) {
  try {
    const file = nameCachePath(dataDir, contentHash);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${JSON.stringify({
      kind: 'MindEntityName',
      schemaVersion: NAME_SCHEMA_VERSION,
      contentHash,
      label,
      fallbackLabel: fallback,
      generatedAt: iso(now),
      source: 'sovereign-single-call',
    }, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
  } catch (error) {
    if (error.code !== 'EEXIST') {
      // Cache is an optimization; a cache write must never block the tick.
    }
  }
}

function nameCachePath(dataDir, contentHash) {
  return safeDataPath(dataDir, path.join(NAME_CACHE_DIR, `${contentHash}.json`));
}

function toolLabel(raw) {
  if (isPlainObject(raw)) {
    return firstPresent([
      raw.label,
      raw.name,
      raw.title,
      isPlainObject(raw.name_mind_entity) ? raw.name_mind_entity.label : undefined,
    ]);
  }
  return optionalString(raw);
}

function hasSpacesOrKnownWord(label, knownWords) {
  if (/\s/.test(label)) return true;
  const [word] = label.split(/\s+/).filter(Boolean);
  return Boolean(word && knownWords.has(normalizeWord(word)));
}

function verbsOnly(words) {
  const significant = words
    .map((word) => normalizeWord(word))
    .filter((word) => word && !CONNECTOR_WORDS.has(word));
  return significant.length > 0 && significant.every((word) => COMMON_VERBS.has(word));
}

function tooManyUnknownWords(words, knownWords) {
  const significant = words
    .map((word) => normalizeWord(word))
    .filter((word) => word && !CONNECTOR_WORDS.has(word));
  if (significant.length === 0) return true;

  const known = significant.filter((word) =>
    knownWords.has(word) || word.length <= 2);
  return known.length === 0 || significant.length - known.length > Math.floor(significant.length / 2);
}

function vocabularyWords(statements, keywords) {
  const words = new Set();
  for (const text of [...normalizedTextList(statements), ...normalizedTextList(keywords)]) {
    for (const token of text.split(/[^a-z0-9'&-]+/i)) {
      const normalized = normalizeWord(token);
      if (normalized) words.add(normalized);
    }
  }
  return words;
}

function normalizeWord(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
}

function normalizedTextList(values) {
  return Array.isArray(values)
    ? values
        .map((value) => optionalString(value))
        .filter(Boolean)
        .map((value) => value.replace(/\s+/g, ' ').trim())
    : [];
}

function stringList(values) {
  return Array.isArray(values)
    ? values.map((value) => optionalString(value)).filter(Boolean).sort()
    : [];
}

function firstPresent(values) {
  for (const value of values) {
    const text = optionalString(value);
    if (text) return text;
  }
  return undefined;
}

async function withTimeout(operation, timeoutMs, label) {
  const limit = Number(timeoutMs);
  if (!Number.isFinite(limit) || limit <= 0) return operation();

  let timer;
  try {
    return await Promise.race([
      operation(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.floor(limit)}ms`)), limit);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function noteNameFallback(onNote, logger, message) {
  if (typeof onNote === 'function') {
    onNote(message);
    return;
  }
  logger?.warn?.(`[cs-k] ${message}`);
}

async function readMindOutputEntries(dataDir) {
  const dir = safeDataPath(dataDir, MIND_OUTPUT_RECORD_DIR);
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  const out = [];
  for (const entry of entries.filter((item) => item.isFile() && item.name.endsWith('.json'))) {
    const relPath = path.join(MIND_OUTPUT_RECORD_DIR, entry.name);
    const file = safeDataPath(dataDir, relPath);
    out.push({
      relPath,
      file,
      record: JSON.parse(await fs.readFile(file, 'utf8')),
    });
  }
  return out;
}

function isLiveRelabelableMindOutput(record) {
  return record &&
    !record.validTo &&
    !record.supersededById &&
    optionalString(record.outputGroup) &&
    record.outputGroup !== 'build_decide' &&
    optionalString(record.outputId ?? record.id);
}

async function recordsForIds({
  dataDir,
  ids,
  cache,
  dirname,
}) {
  const records = [];
  for (const id of ids) {
    if (!cache.has(id)) {
      cache.set(id, readRecord(dataDir, dirname, id));
    }
    const record = await cache.get(id);
    if (record) records.push(record);
  }
  return records;
}

async function readRecord(dataDir, dirname, id) {
  try {
    const file = safeDataPath(dataDir, path.join(dirname, `${id}.json`));
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
