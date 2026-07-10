import { spawn } from 'node:child_process';
import path from 'node:path';

import { BUILD_CARD_KIND_LINE_STOP } from './build-cards.mjs';
import {
  BUILD_STATE_HELD,
} from './build-state.mjs';
import { diffAgainstBase } from './build-git.mjs';
import {
  isPlainObject,
  optionalString,
} from '../substrate.mjs';

export const DEFAULT_SUITE_GATE_TIMEOUT_MS = 5 * 60 * 1000;
export const DEFAULT_GATE_OUTPUT_TAIL_BYTES = 64 * 1024;
export const SHARED_HELPER_NAMES = Object.freeze([
  'atomicWriteJson',
  'writeSseEvent',
  'withTimeout',
  'optionalString',
  'isPlainObject',
  'safeDataPath',
  'iso',
  'heldNotice',
]);

const SHARED_HELPER_HOME_FILES = Object.freeze({
  atomicWriteJson: 'src/agent/routines.mjs',
  writeSseEvent: 'daemon/routes/agui.mjs',
  withTimeout: 'src/ingest/apple-notes.mjs',
  optionalString: 'src/substrate.mjs',
  isPlainObject: 'src/substrate.mjs',
  safeDataPath: 'daemon/run.mjs',
  iso: 'daemon/run.mjs',
  heldNotice: 'src/agent/chat.mjs',
});

const CONTRACT_EXPORT_HOME_FILES = Object.freeze({
  VIEW_TYPES: 'src/agent/view-packet.mjs',
  VIEW_PACKET_PATCH_OPS: 'src/agent/view-packet.mjs',
  TRANSITIONS: 'src/agent/build-state.mjs',
  BUILD_STATES: 'src/agent/build-state.mjs',
});

const CONTRACT_EXPORT_NAMES = Object.freeze(Object.keys(CONTRACT_EXPORT_HOME_FILES));
const DEFAULT_LINE_STOP_MAX_RETRIES = 2;

export async function suiteGate(options = {}) {
  const worktreePath = path.resolve(requiredOption(options.worktreePath, 'worktreePath'));
  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_SUITE_GATE_TIMEOUT_MS);
  const outputTailBytes = positiveInteger(options.outputTailBytes, DEFAULT_GATE_OUTPUT_TAIL_BYTES);
  const attempts = gateAttemptCount(options) || 1;

  const startedAt = new Date().toISOString();
  const child = spawn(process.execPath, ['--test', 'src/'], {
    cwd: worktreePath,
    env: suiteGateEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let tail = Buffer.alloc(0);
  let timedOut = false;
  let spawnError = null;
  const appendOutput = (chunk) => {
    tail = appendTailBytes(tail, chunk, outputTailBytes);
  };

  child.stdout?.on('data', appendOutput);
  child.stderr?.on('data', appendOutput);
  child.on('error', (error) => {
    spawnError = error;
  });

  const exit = await new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      resolve(result);
    };
    const timeoutId = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    timeoutId.unref?.();

    child.on('error', (error) => {
      finish({
        code: null,
        signal: null,
        error,
      });
    });
    child.on('close', (code, signal) => {
      finish({ code, signal, error: spawnError });
    });
  });

  const output = tail.toString('utf8');
  const summary = parseSuiteSummary(output);
  const reason = timedOut
    ? 'timeout'
    : exit.error
      ? 'spawn_error'
      : exit.code === 0 && summary.fail === 0
        ? null
        : 'failed';

  return {
    ok: reason === null,
    reason,
    pass: summary.pass,
    fail: summary.fail,
    attempts,
    output,
    outputTail: output,
    outputTailBytes,
    timedOut,
    timeoutMs,
    exitCode: exit.code,
    signal: exit.signal,
    startedAt,
    finishedAt: new Date().toISOString(),
    ...(exit.error ? { error: optionalString(exit.error.message) ?? String(exit.error) } : {}),
  };
}

export async function hygieneGate(options = {}) {
  const diffText = await resolveDiffText(options);
  const violations = hygieneViolationsForDiff(diffText);
  return {
    ok: violations.length === 0,
    violations,
  };
}

export function hygieneViolationsForDiff(diffText) {
  const violations = [];
  for (const entry of parseUnifiedDiff(optionalString(diffText) ?? '')) {
    for (const added of entry.added) {
      const sharedHelper = copiedSharedHelperName(added.text, entry.file);
      if (sharedHelper) {
        violations.push({
          file: entry.file,
          line: added.line,
          rule: 'shared-helper-recopy',
          detail: `${sharedHelper} is a canonical shared helper; import it from ${SHARED_HELPER_HOME_FILES[sharedHelper]} instead of re-declaring it.`,
        });
      }

      const shadowedContract = shadowedContractName(added.text, entry.file);
      if (shadowedContract) {
        violations.push({
          file: entry.file,
          line: added.line,
          rule: 'contract-import-shadow',
          detail: `${shadowedContract} is exported by ${CONTRACT_EXPORT_HOME_FILES[shadowedContract]}; import it instead of declaring a local constant.`,
        });
      }
    }
  }
  return violations;
}

export async function redFoundation(input = {}) {
  const store = requiredStore(input.store, 'store');
  const cards = requiredStore(input.cards, 'cards');
  const planId = requiredOption(input.planId, 'planId');
  const unitId = requiredOption(input.unitId, 'unitId');
  const actor = optionalString(input.actor) ?? 'runner';
  const gateResult = isPlainObject(input.gateResult) ? input.gateResult : {};

  if (gateResult.ok === true) {
    throw new Error('redFoundation requires a failing gate result');
  }

  await store.transition({
    planId,
    unitId,
    to: BUILD_STATE_HELD,
    actor,
    reason: gateFailureReason(gateResult),
  });

  const recommendation = flakyFailure(gateResult) ? 'retry' : 'kill';
  const raised = await cards.raiseCard({
    kind: BUILD_CARD_KIND_LINE_STOP,
    planId,
    unitId,
    title: 'Verification gate failed',
    body: lineStopBody(gateResult),
    options: lineStopOptions(),
    recommendation,
  });

  return raised.card;
}

export function retryAllowed(unitOrResult, max = DEFAULT_LINE_STOP_MAX_RETRIES) {
  const limit = positiveInteger(max, DEFAULT_LINE_STOP_MAX_RETRIES);
  return gateAttemptCount(unitOrResult) < limit;
}

async function resolveDiffText(options) {
  if (typeof options.diffText === 'string') return options.diffText;
  if (typeof options.diff === 'string') return options.diff;
  if (typeof options.diffFiles === 'string') return options.diffFiles;
  if (isPlainObject(options.diffFiles) && typeof options.diffFiles.diff === 'string') {
    return options.diffFiles.diff;
  }
  if (isPlainObject(options.diffFiles) && typeof options.diffFiles.stdout === 'string') {
    return options.diffFiles.stdout;
  }
  const result = await diffAgainstBase({
    repoRoot: requiredOption(options.worktreePath, 'worktreePath'),
    baseRef: requiredOption(options.baseRef, 'baseRef'),
    execFileImpl: options.execFileImpl,
    timeoutMs: options.timeoutMs,
  });
  return result.diff;
}

function parseSuiteSummary(output) {
  const summaryPass = summaryNumber(output, 'pass');
  const summaryFail = summaryNumber(output, 'fail');
  return {
    pass: summaryPass ?? tapLineCount(output, 'ok'),
    fail: summaryFail ?? tapLineCount(output, 'not ok'),
  };
}

function summaryNumber(output, label) {
  const match = new RegExp(`^#\\s+${escapeRegExp(label)}\\s+(\\d+)\\s*$`, 'm').exec(output);
  return match ? Number(match[1]) : null;
}

function tapLineCount(output, prefix) {
  const pattern = prefix === 'not ok'
    ? /^not ok\s+\d+\b/gm
    : /^ok\s+\d+\b/gm;
  return [...output.matchAll(pattern)].length;
}

function parseUnifiedDiff(diffText) {
  const files = [];
  let current = null;
  let newLine = 0;
  let oldLine = 0;

  for (const rawLine of diffText.split('\n')) {
    if (rawLine.startsWith('diff --git ')) {
      if (current) files.push(current);
      current = { file: null, added: [] };
      newLine = 0;
      oldLine = 0;
      continue;
    }

    if (!current) current = { file: null, added: [] };

    if (rawLine.startsWith('+++ ')) {
      current.file = normalizeDiffFile(rawLine.slice(4));
      continue;
    }

    if (rawLine.startsWith('@@ ')) {
      const hunk = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(rawLine);
      if (hunk) {
        oldLine = Number(hunk[1]);
        newLine = Number(hunk[2]);
      }
      continue;
    }

    if (rawLine.startsWith('+') && !rawLine.startsWith('+++')) {
      current.added.push({
        line: newLine || 1,
        text: rawLine.slice(1),
      });
      newLine += 1;
      continue;
    }

    if (rawLine.startsWith('-') && !rawLine.startsWith('---')) {
      oldLine += 1;
      continue;
    }

    if (rawLine.startsWith(' ')) {
      oldLine += 1;
      newLine += 1;
    }
  }

  if (current) files.push(current);
  return files
    .filter((entry) => optionalString(entry.file))
    .map((entry) => ({
      file: entry.file,
      added: entry.added,
    }));
}

function copiedSharedHelperName(line, file) {
  for (const name of SHARED_HELPER_NAMES) {
    if (normalizeRelPath(file) === SHARED_HELPER_HOME_FILES[name]) continue;
    if (declaresFunction(line, name) || declaresConst(line, name)) return name;
  }
  return null;
}

function shadowedContractName(line, file) {
  const rel = normalizeRelPath(file);
  if (!isAgentOrDaemonFile(rel)) return null;

  for (const name of CONTRACT_EXPORT_NAMES) {
    if (rel === CONTRACT_EXPORT_HOME_FILES[name]) continue;
    if (declaresConst(line, name)) return name;
  }
  return null;
}

function declaresFunction(line, name) {
  const pattern = new RegExp(`^(?:\\s*export\\s+)?(?:\\s*async\\s+)?function\\s+${escapeRegExp(name)}\\s*\\(`);
  return pattern.test(line);
}

function declaresConst(line, name) {
  const pattern = new RegExp(`^(?:\\s*export\\s+)?\\s*const\\s+${escapeRegExp(name)}\\s*=`);
  return pattern.test(line);
}

function normalizeDiffFile(value) {
  const file = optionalString(value);
  if (!file || file === '/dev/null') return null;
  if (file.startsWith('b/')) return normalizeRelPath(file.slice(2));
  if (file.startsWith('a/')) return normalizeRelPath(file.slice(2));
  return normalizeRelPath(file);
}

function normalizeRelPath(value) {
  return String(value ?? '').replaceAll('\\', '/').replace(/^\.\//, '');
}

function isAgentOrDaemonFile(file) {
  return file.startsWith('src/agent/') || file.startsWith('daemon/');
}

function appendTailBytes(previous, chunk, cap) {
  const next = Buffer.concat([previous, Buffer.from(chunk)]);
  return next.length <= cap ? next : next.subarray(next.length - cap);
}

function suiteGateEnv() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

function lineStopOptions() {
  return [
    {
      id: 'retry',
      label: 'Retry',
      consequence: `Run the verification gate again, bounded to ${DEFAULT_LINE_STOP_MAX_RETRIES} attempts.`,
    },
    {
      id: 'quarantine',
      label: 'Quarantine',
      consequence: 'Founder-only: isolate the unit and keep the rest of the plan moving.',
    },
    {
      id: 'kill',
      label: 'Kill',
      consequence: 'Stop the unit and do not integrate this lane.',
    },
  ];
}

function lineStopBody(gateResult) {
  const reason = gateFailureReason(gateResult);
  const output = optionalString(gateResult.outputTail ?? gateResult.output);
  const summary = `Suite gate failed (${reason}); pass=${Number(gateResult.pass ?? 0)}, fail=${Number(gateResult.fail ?? 0)}, attempt=${gateAttemptCount(gateResult)}.`;
  return output ? `${summary}\n\n${output}` : summary;
}

function gateFailureReason(gateResult) {
  return optionalString(gateResult.reason) ?? (gateResult.timedOut ? 'timeout' : 'failed');
}

function flakyFailure(gateResult) {
  return gateFailureReason(gateResult) !== 'timeout' &&
    Number(gateResult.fail ?? 0) === 1 &&
    gateAttemptCount(gateResult) <= 1;
}

function gateAttemptCount(value) {
  if (!isPlainObject(value)) return 0;
  for (const key of ['attempts', 'attemptCount', 'gateAttempts', 'suiteAttempts', 'verificationAttempts']) {
    const number = Number(value[key]);
    if (Number.isSafeInteger(number) && number >= 0) return number;
  }
  if (isPlainObject(value.gateResult)) return gateAttemptCount(value.gateResult);
  if (isPlainObject(value.suiteGate)) return gateAttemptCount(value.suiteGate);
  if (isPlainObject(value.gates?.suite)) return gateAttemptCount(value.gates.suite);
  if (isPlainObject(value.gateResults?.suite)) return gateAttemptCount(value.gateResults.suite);
  return 0;
}

function requiredStore(value, label) {
  if (!value || typeof value !== 'object') throw new Error(`${label} is required`);
  return value;
}

function requiredOption(value, label) {
  const text = optionalString(value);
  if (!text) throw new Error(`${label} is required`);
  return text;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
