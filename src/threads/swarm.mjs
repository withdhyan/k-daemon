import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  ROOT,
  iso,
  runStation,
  safeDataPath,
  stamp,
  writeUniqueDataJson,
} from '../../daemon/run.mjs';
import { research as researchPipeline } from '../research/pipeline.mjs';
import {
  optionalString,
  requiredString,
} from '../substrate.mjs';

export const THREAD_SWARM_SCHEMA_VERSION = 1;
export const SWARM_ROLES = Object.freeze(['explorer', 'worker', 'verifier']);

const DEFAULT_DATA_DIR = path.join(ROOT, 'data');

export function createScopedWriter({
  dataDir,
  threadId,
  role,
} = {}) {
  const resolvedDataDir = path.resolve(dataDir ?? process.env.CS_K_DATA_DIR ?? DEFAULT_DATA_DIR);
  const normalizedThreadId = safePathSegment(threadId, 'threadId');
  const normalizedRole = assertRole(role);
  const scopeRel = path.join('threads', normalizedThreadId, normalizedRole);
  const scopeRoot = safeDataPath(resolvedDataDir, scopeRel);

  function scopedPath(relPath) {
    return safeDataPath(scopeRoot, relPath);
  }

  async function writeJson(relPath, value) {
    const file = scopedPath(relPath);
    await fs.mkdir(path.dirname(file), { recursive: true });
    try {
      await fs.writeFile(
        file,
        `${JSON.stringify(value, null, 2)}\n`,
        {
          encoding: 'utf8',
          flag: 'wx',
        },
      );
    } catch (error) {
      if (error.code === 'EEXIST') {
        throw new Error(`refused to overwrite scoped data path: ${relPath}`, {
          cause: error,
        });
      }
      throw error;
    }
    return scopedMutation(scopeRel, relPath, value);
  }

  async function writeUniqueJson(dirname, baseName, value) {
    const relPath = await writeUniqueDataJson(scopeRoot, dirname, baseName, value);
    return scopedMutation(scopeRel, relPath, value);
  }

  return Object.freeze({
    role: normalizedRole,
    threadId: normalizedThreadId,
    scopeRel,
    scopeRoot,
    path: scopedPath,
    writeJson,
    writeUniqueJson,
  });
}

export async function runThreadSwarm(thread, ctx, deps = {}) {
  const normalizedThread = normalizeThread(thread);
  const dispatch = deps.dispatch ?? deps.swarmDispatch ?? 'parallel';
  const roles = [
    ['explorer', () => explorer(normalizedThread, ctx, depsForRole(deps, normalizedThread, 'explorer'))],
    ['worker', () => worker(normalizedThread, ctx, depsForRole(deps, normalizedThread, 'worker'))],
    ['verifier', () => verifier(normalizedThread, ctx, depsForRole(deps, normalizedThread, 'verifier'))],
  ];

  const pairs = dispatch === 'serial'
    ? await runSerial(roles, normalizedThread)
    : await runParallel(roles, normalizedThread);

  return Object.freeze({
    threadId: normalizedThread.threadId,
    roles: Object.freeze(Object.fromEntries(pairs)),
  });
}

export async function explorer(thread, ctx, deps = {}) {
  const normalizedThread = normalizeThread(thread);
  const writer = requireWriter(deps, normalizedThread, 'explorer');
  const now = deps.now ?? (() => new Date());
  const runResearch = deps.research ?? researchPipeline;
  const evidence = await runResearch(explorerQuery(normalizedThread, ctx), {
    store: deps.store,
    dataDir: deps.dataDir,
    now,
    ...(deps.embedder ? { embedder: deps.embedder } : {}),
    ...(deps.testEmbedder ? { testEmbedder: deps.testEmbedder } : {}),
    ...(deps.researchOptions ?? {}),
  });
  const scopedEvidence = normalizeEvidence(evidence)
    .filter((item) => evidenceBelongsToThread(item, normalizedThread));
  const record = {
    kind: 'ThreadExplorerEvidence',
    schemaVersion: THREAD_SWARM_SCHEMA_VERSION,
    threadId: normalizedThread.threadId,
    role: 'explorer',
    theme: normalizedThread.theme,
    evidenceIds: uniqueStrings(scopedEvidence.flatMap((item) => item.evidenceIds)),
    evidence: scopedEvidence,
    createdAt: iso(now),
  };
  const mutation = await writer.writeUniqueJson('', stamp(now), record);

  return Object.freeze({
    role: 'explorer',
    threadId: normalizedThread.threadId,
    evidenceIds: record.evidenceIds,
    evidence: record.evidence,
    mutations: Object.freeze([mutation]),
    record,
  });
}

export async function worker(thread, ctx, deps = {}) {
  const normalizedThread = normalizeThread(thread);
  const writer = requireWriter(deps, normalizedThread, 'worker');
  const run = deps.runStation ?? runStation;
  const result = await run('decide', {
    store: deps.store,
    dataDir: writer.scopeRoot,
    now: deps.now,
    modelCall: deps.modelCall,
    input: deps.workerInput ?? workerInput(normalizedThread),
    quiet: true,
    contextLimit: deps.contextLimit,
    threadId: normalizedThread.threadId,
    threadExposureIds: normalizedThread.exposureIds,
  });

  return Object.freeze({
    role: 'worker',
    threadId: normalizedThread.threadId,
    output: result.output,
    mutations: Object.freeze(result.mutations.map((mutation) => rebaseMutation(writer, mutation))),
    station: result,
  });
}

export async function verifier(thread, ctx, deps = {}) {
  const normalizedThread = normalizeThread(thread);
  const writer = requireWriter(deps, normalizedThread, 'verifier');
  const run = deps.runStation ?? runStation;
  const result = await run('verify', {
    store: deps.store,
    dataDir: writer.scopeRoot,
    now: deps.now,
    modelCall: deps.verifyModelCall ?? deps.modelCall,
    input: deps.verifierInput ?? verifierInput(normalizedThread),
    quiet: true,
    contextLimit: deps.contextLimit,
    threadId: normalizedThread.threadId,
    threadExposureIds: normalizedThread.exposureIds,
  });

  return Object.freeze({
    role: 'verifier',
    threadId: normalizedThread.threadId,
    output: result.output,
    mutations: Object.freeze(result.mutations.map((mutation) => rebaseMutation(writer, mutation))),
    station: result,
  });
}

function depsForRole(deps, thread, role) {
  return {
    ...deps,
    writer: deps.writers?.[role] ?? deps.writer ?? createScopedWriter({
      dataDir: deps.dataDir,
      threadId: thread.threadId,
      role,
    }),
  };
}

async function runParallel(roles, thread) {
  const settled = await Promise.allSettled(
    roles.map(async ([role, operation]) => [role, await operation()]),
  );

  return settled.map((result, index) => {
    if (result.status === 'fulfilled') return result.value;
    return [roles[index][0], failedRoleResult(roles[index][0], thread, result.reason)];
  });
}

async function runSerial(roles, thread) {
  const pairs = [];
  for (const [role, operation] of roles) {
    try {
      pairs.push([role, await operation()]);
    } catch (error) {
      pairs.push([role, failedRoleResult(role, thread, error)]);
    }
  }
  return pairs;
}

function failedRoleResult(role, thread, error) {
  return Object.freeze({
    role,
    threadId: thread.threadId,
    error: errorDetails(error),
    mutations: Object.freeze([]),
  });
}

export function errorDetails(error) {
  const details = {
    name: optionalString(error?.name) ?? 'Error',
    message: optionalString(error?.message) ?? String(error),
  };
  const code = optionalString(error?.code);
  if (code) details.code = code;
  return Object.freeze(details);
}

function requireWriter(deps, thread, role) {
  const writer = deps.writer ?? createScopedWriter({
    dataDir: deps.dataDir,
    threadId: thread.threadId,
    role,
  });
  if (writer.threadId !== thread.threadId || writer.role !== role) {
    throw new Error(`writer scope mismatch for ${thread.threadId}/${role}`);
  }
  return writer;
}

function rebaseMutation(writer, mutation) {
  if (!mutation || typeof mutation !== 'object') return mutation;
  const dataPrefix = `data${path.sep}`;
  const pathText = optionalString(mutation.path);
  if (!pathText) return mutation;
  const relPath = pathText.startsWith(dataPrefix)
    ? pathText.slice(dataPrefix.length)
    : pathText;
  return {
    ...mutation,
    path: path.join('data', writer.scopeRel, relPath),
  };
}

function scopedMutation(scopeRel, relPath, value) {
  return {
    op: 'write',
    path: path.join('data', scopeRel, relPath),
    kind: optionalString(value?.kind) ?? 'ThreadSwarmRecord',
  };
}

function normalizeThread(thread) {
  if (!thread || typeof thread !== 'object' || Array.isArray(thread)) {
    throw new Error('thread must be an object');
  }

  return Object.freeze({
    ...thread,
    threadId: safePathSegment(thread.threadId, 'thread.threadId'),
    theme: optionalString(thread.theme) ?? '',
    exposureIds: normalizeStringArray(thread.exposureIds ?? [], 'thread.exposureIds'),
  });
}

function explorerQuery(thread, ctx) {
  return [
    `Thread ${thread.threadId}`,
    thread.theme ? `Theme: ${thread.theme}` : '',
    `Exposure ids: ${thread.exposureIds.join(', ')}`,
    optionalString(ctx) ?? '',
  ].filter(Boolean).join('\n\n');
}

function workerInput(thread) {
  return [
    `Thread ${thread.threadId}: decide whether any advisory recommendation earns surfacing.`,
    thread.theme ? `Theme: ${thread.theme}` : '',
    `Evidence scope: ${thread.exposureIds.join(', ') || '(none)'}.`,
    'Silence unless the thread contains a decision worth staging for human review.',
  ].filter(Boolean).join('\n');
}

function verifierInput(thread) {
  return [
    `Thread ${thread.threadId}: verify longitudinal consistency for this thread only.`,
    thread.theme ? `Theme: ${thread.theme}` : '',
    `Evidence scope: ${thread.exposureIds.join(', ') || '(none)'}.`,
    'Record only advisory verification notes; do not act.',
  ].filter(Boolean).join('\n');
}

function normalizeEvidence(items) {
  if (!Array.isArray(items)) return [];
  return items.map((item) => {
    const evidenceIds = uniqueStrings([
      ...(Array.isArray(item?.evidenceIds) ? item.evidenceIds : []),
      ...(optionalString(item?.evidenceId) ? [item.evidenceId] : []),
    ]);

    return {
      evidenceId: evidenceIds[0],
      evidenceIds,
      evidenceGrade: optionalString(item?.evidenceGrade) ?? 'L1',
      source: optionalString(item?.source) ?? 'research',
      relevanceScore: finiteNumber(item?.relevanceScore ?? 0),
      noveltySatisfied: item?.noveltySatisfied === true,
      attentionState: optionalString(item?.attentionState) ?? 'neutral',
      kind: optionalString(item?.kind ?? item?.record?.kind),
      content: optionalString(item?.content),
      record: item?.record,
    };
  });
}

function evidenceBelongsToThread(item, thread) {
  const threadExposureIds = new Set(thread.exposureIds);
  if (threadExposureIds.size === 0) return false;

  if (item.record?.kind === 'Exposure') {
    return threadExposureIds.has(item.record.id);
  }

  const referencedIds = uniqueStrings([
    ...asStringArray(item.record?.evidence),
    ...asStringArray(item.record?.evidenceIds),
    ...asStringArray(item.record?.exposureIds),
    ...asStringArray(item.record?.engagement?.exposureId),
    ...asStringArray(item.evidenceIds),
  ]);

  return referencedIds.length > 0 &&
    referencedIds.every((id) => threadExposureIds.has(id) || item.evidenceId === id);
}

function asStringArray(value) {
  if (Array.isArray(value)) return value;
  const text = optionalString(value);
  return text ? [text] : [];
}

function assertRole(role) {
  const normalized = requiredString(role, 'role');
  if (!SWARM_ROLES.includes(normalized)) {
    throw new Error(`unknown swarm role: ${role}`);
  }
  return normalized;
}

function safePathSegment(value, label) {
  const segment = requiredString(value, label);
  if (
    segment === '.' ||
    segment === '..' ||
    segment.includes('\0') ||
    path.isAbsolute(segment) ||
    path.win32.isAbsolute(segment) ||
    segment.split(/[\\/]+/).length !== 1
  ) {
    throw new Error(`unsafe path segment for ${label}: ${value}`);
  }
  return segment;
}

function normalizeStringArray(values, field) {
  if (!Array.isArray(values)) throw new Error(`${field} must be an array`);
  return uniqueStrings(values.map((value) => requiredString(value, `${field} item`)));
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => optionalString(value)).filter(Boolean))];
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}
