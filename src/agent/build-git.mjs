import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { iso } from '../../daemon/run.mjs';
import {
  optionalString,
  requiredString,
} from '../substrate.mjs';
import { withTimeout } from '../ingest/apple-notes.mjs';

export const GIT_PATH = '/usr/bin/git';
export const BUILD_WORKTREES_DIR = path.join('.worktrees', 'lanes');
export const DEFAULT_GIT_TIMEOUT_MS = 60_000;

const execFileAsync = promisify(execFile);
const GIT_MAX_BUFFER = 16 * 1024 * 1024;
const LANE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;

export class GitCommandError extends Error {
  constructor(message, context = {}) {
    super(message);
    this.name = 'GitCommandError';
    this.args = context.args;
    this.cwd = context.cwd;
    this.exitCode = context.exitCode;
    this.stdout = context.stdout ?? '';
    this.stderr = context.stderr ?? '';
    this.cause = context.cause;
  }
}

export async function laneWorktreeAdd(options = {}) {
  const repoRoot = normalizeRepoRoot(options.repoRoot);
  const laneId = assertLaneId(options.laneId);
  const baseSha = requiredString(options.baseSha, 'baseSha');
  const laneWorktree = laneWorktreePath({ repoRoot, laneId });
  const execOptions = gitExecOptions(options);

  await ensureWorktreesExcluded(repoRoot, execOptions);
  await fs.mkdir(path.dirname(laneWorktree), { recursive: true });
  // Idempotent add: a failed/killed prior lane leaves its worktree behind and
  // every retry would die on 'already exists' (observed live 2026-07-05).
  await fs.rm(laneWorktree, { recursive: true, force: true });
  await runGit(['worktree', 'prune'], { ...execOptions, cwd: repoRoot, label: 'git worktree prune (pre-add)' }).catch(() => {});
  await runGit(['worktree', 'add', '--detach', laneWorktree, baseSha], {
    ...execOptions,
    cwd: repoRoot,
    label: `git worktree add ${laneId}`,
  });

  return {
    ok: true,
    laneId,
    path: laneWorktree,
    baseSha,
    sha: await revParseHead(laneWorktree, execOptions),
    createdAt: iso(options.now ?? new Date()),
  };
}

export async function laneWorktreeRemove(options = {}) {
  const repoRoot = normalizeRepoRoot(options.repoRoot);
  const laneId = assertLaneId(options.laneId);
  const laneWorktree = laneWorktreePath({ repoRoot, laneId });
  const execOptions = gitExecOptions(options);

  if (!await pathExists(laneWorktree)) {
    return {
      ok: true,
      laneId,
      path: laneWorktree,
      removed: false,
      reason: 'missing',
    };
  }

  const args = ['worktree', 'remove'];
  if (options.force === true) args.push('--force');
  args.push(laneWorktree);

  try {
    await runGit(args, {
      ...execOptions,
      cwd: repoRoot,
      label: `git worktree remove ${laneId}`,
    });
  } catch (error) {
    if (error instanceof GitCommandError && isDirtyGitOutput(error)) {
      return {
        ok: false,
        dirty: true,
        laneId,
        path: laneWorktree,
        error: gitErrorMessage(error),
      };
    }
    throw error;
  }

  return {
    ok: true,
    laneId,
    path: laneWorktree,
    removed: true,
    removedAt: iso(options.now ?? new Date()),
  };
}

export async function pruneWorktrees(options = {}) {
  const repoRoot = normalizeRepoRoot(options.repoRoot);
  const liveLaneIds = normalizeLiveLaneIds(options.liveLaneIds ?? options.liveIds ?? []);
  const execOptions = gitExecOptions(options);

  await runGit(['worktree', 'prune'], {
    ...execOptions,
    cwd: repoRoot,
    label: 'git worktree prune',
  });

  const lanesRoot = path.join(repoRoot, BUILD_WORKTREES_DIR);
  const registered = await registeredWorktreePaths(repoRoot, execOptions);
  const removed = [];
  let entries = [];

  try {
    entries = await fs.readdir(lanesRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  for (const entry of entries) {
    const laneId = entry.name;
    if (liveLaneIds.has(laneId)) continue;

    const stalePath = assertPathUnderRoot(
      path.join(lanesRoot, laneId),
      lanesRoot,
      'stale lane worktree',
    );
    let gitRemoved = false;
    if (registered.has(path.resolve(stalePath))) {
      try {
        await runGit(['worktree', 'remove', '--force', stalePath], {
          ...execOptions,
          cwd: repoRoot,
          label: `git worktree remove stale ${laneId}`,
        });
        gitRemoved = true;
      } catch (error) {
        if (!(error instanceof GitCommandError) || !isMissingWorktreeOutput(error)) {
          throw error;
        }
      }
    }

    await fs.rm(stalePath, { recursive: true, force: true });
    removed.push({
      laneId,
      path: stalePath,
      gitRemoved,
    });
  }

  const lockCleanup = await cleanIndexLocks({
    repoRoot,
    ...execOptions,
    requireNoGitProcess: true,
    isGitProcessRunningImpl: options.isGitProcessRunningImpl,
  });

  return {
    ok: true,
    pruned: true,
    liveLaneIds: [...liveLaneIds].sort(),
    removed,
    lockCleanup,
    prunedAt: iso(options.now ?? new Date()),
  };
}

export async function checkpoint(options = {}) {
  const repoRoot = normalizeRepoRoot(options.repoRoot);
  return {
    ok: true,
    sha: await revParseHead(repoRoot, gitExecOptions(options)),
    checkpointedAt: iso(options.now ?? new Date()),
  };
}

export async function diffAgainstBase(options = {}) {
  const repoRoot = normalizeRepoRoot(options.repoRoot ?? options.worktreePath);
  const baseRef = requiredString(options.baseRef, 'baseRef');
  const execOptions = gitExecOptions(options);
  const result = await runGit(['diff', '--unified=0', '--no-ext-diff', baseRef, '--'], {
    ...execOptions,
    cwd: repoRoot,
    label: `git diff ${baseRef}`,
  });

  return {
    ok: true,
    repoRoot,
    baseRef,
    diff: result.stdout,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export async function integrate(options = {}) {
  const repoRoot = normalizeRepoRoot(options.repoRoot);
  const laneWorktree = normalizeLaneWorktree(options.laneWorktree, repoRoot);
  const baseShaAtGate = requiredString(options.baseShaAtGate, 'baseShaAtGate');
  const execOptions = gitExecOptions(options);

  const baseSha = await revParseHead(repoRoot, execOptions);
  const laneSha = await revParseHead(laneWorktree, execOptions);
  const regateRequired = baseSha !== baseShaAtGate;
  const common = {
    baseSha,
    baseShaAtGate,
    laneSha,
    regateRequired,
  };

  const integration = await integrationState(repoRoot, execOptions);
  if (integration.mergeHead || integration.cherryPickHead || integration.indexLock) {
    return {
      ok: false,
      dirty: true,
      integrationInProgress: true,
      ...common,
      files: [],
      found: integration,
    };
  }

  const dirty = await trackedDirtyFiles(repoRoot, execOptions);
  if (dirty.length > 0) {
    return {
      ok: false,
      dirty: true,
      ...common,
      files: dirty,
    };
  }

  const protectedFiles = await changedDataPaths(repoRoot, baseShaAtGate, laneSha, execOptions);
  if (protectedFiles.length > 0) {
    return {
      ok: false,
      protectedPath: true,
      ...common,
      files: protectedFiles,
    };
  }

  if (laneSha === baseSha) {
    return {
      ok: true,
      noop: true,
      sha: baseSha,
      ...common,
      integratedAt: iso(options.now ?? new Date()),
    };
  }

  try {
    await runGit(['merge', '--no-edit', laneSha], {
      ...execOptions,
      cwd: repoRoot,
      label: `git merge ${laneSha}`,
    });
  } catch (error) {
    if (!(error instanceof GitCommandError)) throw error;

    const files = await unmergedFiles(repoRoot, execOptions).catch(() => []);
    if (files.length > 0 || isConflictGitOutput(error)) {
      const abortActions = await abortIntegration(repoRoot, execOptions);
      return {
        ok: false,
        conflict: true,
        ...common,
        files,
        abortActions,
        headAfterAbort: await revParseHead(repoRoot, execOptions),
        error: gitErrorMessage(error),
      };
    }

    if (isDirtyGitOutput(error)) {
      return {
        ok: false,
        dirty: true,
        ...common,
        files: await statusFiles(repoRoot, execOptions).catch(() => []),
        error: gitErrorMessage(error),
      };
    }

    throw error;
  }

  return {
    ok: true,
    sha: await revParseHead(repoRoot, execOptions),
    ...common,
    integratedAt: iso(options.now ?? new Date()),
  };
}

export async function recoverIntegration(options = {}) {
  const repoRoot = normalizeRepoRoot(options.repoRoot);
  const checkpointSha = requiredString(options.checkpointSha, 'checkpointSha');
  const execOptions = gitExecOptions(options);

  const gitDir = await resolveGitDir(repoRoot, execOptions);
  const headBefore = await revParseHead(repoRoot, execOptions);
  const found = await integrationState(repoRoot, execOptions, { gitDir });
  const actions = [];

  if (found.indexLock) {
    await removeExistingFile(found.indexLock);
    actions.push({ action: 'remove-index-lock', path: found.indexLock });
  }

  const dirtyFiles = await trackedDirtyFiles(repoRoot, execOptions).catch(() => []);
  const dirty = dirtyFiles.length > 0;
  const shouldReset = Boolean(found.mergeHead || found.cherryPickHead || found.indexLock || dirty);

  if (shouldReset) {
    await runGit(['reset', '--hard', checkpointSha], {
      ...execOptions,
      cwd: repoRoot,
      label: `git reset --hard ${checkpointSha}`,
    });
    actions.push({ action: 'reset-hard', sha: checkpointSha });
  }

  const lockCleanup = await cleanIndexLocks({
    repoRoot,
    ...execOptions,
    requireNoGitProcess: false,
  });
  if (lockCleanup.removed.length > 0) {
    actions.push(...lockCleanup.removed.map((entry) => ({
      action: 'remove-index-lock',
      path: entry,
    })));
  }

  return {
    ok: true,
    checkpointSha,
    headBefore,
    headAfter: await revParseHead(repoRoot, execOptions),
    found: {
      mergeHead: found.mergeHead,
      cherryPickHead: found.cherryPickHead,
      indexLock: found.indexLock,
      dirty,
      dirtyFiles,
    },
    actions,
    recoveredAt: iso(options.now ?? new Date()),
  };
}

export function laneWorktreePath({ repoRoot, laneId } = {}) {
  const root = normalizeRepoRoot(repoRoot);
  const lanesRoot = path.join(root, BUILD_WORKTREES_DIR);
  return assertPathUnderRoot(
    path.join(lanesRoot, assertLaneId(laneId)),
    lanesRoot,
    'lane worktree',
  );
}

async function runGit(args, options = {}) {
  const cwd = normalizeCwd(options.cwd);
  const timeoutMs = positiveTimeout(options.timeoutMs);
  const label = options.label ?? `git ${args.join(' ')}`;
  const normalizedArgs = args.map((arg) => String(arg));
  const childOptions = {
    cwd,
    maxBuffer: GIT_MAX_BUFFER,
    timeout: timeoutMs,
    windowsHide: true,
  };

  try {
    return normalizeExecResult(await withTimeout(
      () => options.execFileImpl(GIT_PATH, normalizedArgs, childOptions),
      timeoutMs,
      label,
    ));
  } catch (error) {
    if (isGitExitError(error)) {
      const stdout = bufferToString(error.stdout);
      const stderr = bufferToString(error.stderr);
      throw new GitCommandError(
        gitErrorMessage({ stdout, stderr, message: error.message }),
        {
          args: normalizedArgs,
          cwd,
          exitCode: error.code,
          stdout,
          stderr,
          cause: error,
        },
      );
    }
    throw error;
  }
}

function gitExecOptions(options = {}) {
  return {
    execFileImpl: options.execFileImpl ?? execFileAsync,
    timeoutMs: positiveTimeout(options.timeoutMs),
  };
}

async function revParseHead(cwd, options) {
  const result = await runGit(['rev-parse', 'HEAD'], {
    ...options,
    cwd,
    label: 'git rev-parse HEAD',
  });
  return requiredString(result.stdout, 'HEAD sha');
}

async function registeredWorktreePaths(repoRoot, options) {
  const result = await runGit(['worktree', 'list', '--porcelain'], {
    ...options,
    cwd: repoRoot,
    label: 'git worktree list',
  });
  const paths = new Set();
  for (const line of result.stdout.split('\n')) {
    if (!line.startsWith('worktree ')) continue;
    paths.add(path.resolve(line.slice('worktree '.length)));
  }
  return paths;
}

async function changedDataPaths(repoRoot, baseSha, laneSha, options) {
  const result = await runGit(['diff', '--name-only', `${baseSha}..${laneSha}`], {
    ...options,
    cwd: repoRoot,
    label: 'git diff lane files',
  });
  return result.stdout
    .split('\n')
    .map((line) => optionalString(line))
    .filter((file) => file && isDataPath(file));
}

async function trackedDirtyFiles(repoRoot, options) {
  const result = await runGit(['status', '--porcelain', '--untracked-files=no'], {
    ...options,
    cwd: repoRoot,
    label: 'git status tracked',
  });
  return parsePorcelainFiles(result.stdout);
}

async function statusFiles(repoRoot, options) {
  const result = await runGit(['status', '--porcelain'], {
    ...options,
    cwd: repoRoot,
    label: 'git status',
  });
  return parsePorcelainFiles(result.stdout);
}

async function unmergedFiles(repoRoot, options) {
  const result = await runGit(['diff', '--name-only', '--diff-filter=U'], {
    ...options,
    cwd: repoRoot,
    label: 'git conflict files',
  });
  return result.stdout
    .split('\n')
    .map((line) => optionalString(line))
    .filter(Boolean);
}

async function abortIntegration(repoRoot, options) {
  const actions = [];
  const state = await integrationState(repoRoot, options);
  if (state.mergeHead) {
    await runGit(['merge', '--abort'], {
      ...options,
      cwd: repoRoot,
      label: 'git merge --abort',
    });
    actions.push('merge --abort');
  }

  const afterMerge = await integrationState(repoRoot, options);
  if (afterMerge.cherryPickHead) {
    await runGit(['cherry-pick', '--abort'], {
      ...options,
      cwd: repoRoot,
      label: 'git cherry-pick --abort',
    });
    actions.push('cherry-pick --abort');
  }

  const afterAbort = await integrationState(repoRoot, options);
  if (afterAbort.indexLock) {
    await removeExistingFile(afterAbort.indexLock);
    actions.push('remove index.lock');
  }
  return actions;
}

async function integrationState(repoRoot, options, cached = {}) {
  const gitDir = cached.gitDir ?? await resolveGitDir(repoRoot, options);
  const mergeHead = path.join(gitDir, 'MERGE_HEAD');
  const cherryPickHead = path.join(gitDir, 'CHERRY_PICK_HEAD');
  const indexLock = path.join(gitDir, 'index.lock');
  return {
    gitDir,
    mergeHead: await pathExists(mergeHead) ? mergeHead : null,
    cherryPickHead: await pathExists(cherryPickHead) ? cherryPickHead : null,
    indexLock: await pathExists(indexLock) ? indexLock : null,
  };
}

async function cleanIndexLocks(options = {}) {
  const repoRoot = normalizeRepoRoot(options.repoRoot);
  const lockPaths = await indexLockPaths(repoRoot, options);
  const existing = [];
  for (const lockPath of lockPaths) {
    if (await pathExists(lockPath)) existing.push(lockPath);
  }

  if (existing.length === 0) {
    return {
      checked: true,
      skipped: false,
      removed: [],
    };
  }

  if (options.requireNoGitProcess === true) {
    const isRunning = await (options.isGitProcessRunningImpl ?? defaultIsGitProcessRunning)();
    if (isRunning) {
      return {
        checked: true,
        skipped: true,
        reason: 'git-process-running',
        locks: existing,
        removed: [],
      };
    }
  }

  const removed = [];
  for (const lockPath of existing) {
    await removeExistingFile(lockPath);
    removed.push(lockPath);
  }

  return {
    checked: true,
    skipped: false,
    removed,
  };
}

async function indexLockPaths(repoRoot, options) {
  const gitDir = await resolveGitDir(repoRoot, options);
  const commonDir = await resolveGitCommonDir(repoRoot, options);
  const paths = new Set([
    path.join(gitDir, 'index.lock'),
    path.join(commonDir, 'index.lock'),
  ]);
  const worktreesDir = path.join(commonDir, 'worktrees');

  try {
    const entries = await fs.readdir(worktreesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) paths.add(path.join(worktreesDir, entry.name, 'index.lock'));
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  return [...paths];
}

async function resolveGitDir(repoRoot, options) {
  const result = await runGit(['rev-parse', '--git-dir'], {
    ...options,
    cwd: repoRoot,
    label: 'git rev-parse --git-dir',
  });
  return resolveGitPath(repoRoot, result.stdout);
}

async function resolveGitCommonDir(repoRoot, options) {
  const result = await runGit(['rev-parse', '--git-common-dir'], {
    ...options,
    cwd: repoRoot,
    label: 'git rev-parse --git-common-dir',
  });
  return resolveGitPath(repoRoot, result.stdout);
}

async function ensureWorktreesExcluded(repoRoot, options) {
  const commonDir = await resolveGitCommonDir(repoRoot, options);
  const excludeFile = path.join(commonDir, 'info', 'exclude');
  const entry = '/.worktrees/';
  let current = '';

  try {
    current = await fs.readFile(excludeFile, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  if (current.split('\n').includes(entry)) return;

  const prefix = current && !current.endsWith('\n') ? '\n' : '';
  await fs.mkdir(path.dirname(excludeFile), { recursive: true });
  await fs.appendFile(excludeFile, `${prefix}${entry}\n`, 'utf8');
}

function resolveGitPath(cwd, value) {
  const location = requiredString(value, 'git path');
  return path.isAbsolute(location) ? path.resolve(location) : path.resolve(cwd, location);
}

async function defaultIsGitProcessRunning() {
  try {
    const result = normalizeExecResult(await execFileAsync('/bin/ps', ['-axo', 'comm='], {
      maxBuffer: 2 * 1024 * 1024,
      timeout: 5_000,
      windowsHide: true,
    }));
    return result.stdout
      .split('\n')
      .map((line) => path.basename(line.trim()))
      .some((name) => name === 'git' || name.startsWith('git-'));
  } catch {
    return true;
  }
}

async function removeExistingFile(file) {
  try {
    await fs.unlink(file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function normalizeRepoRoot(value) {
  return path.resolve(requiredString(value, 'repoRoot'));
}

function normalizeCwd(value) {
  return path.resolve(requiredString(value, 'cwd'));
}

function normalizeLaneWorktree(value, repoRoot) {
  const laneWorktree = path.resolve(requiredString(value, 'laneWorktree'));
  return assertPathUnderRoot(
    laneWorktree,
    path.join(repoRoot, BUILD_WORKTREES_DIR),
    'laneWorktree',
  );
}

function assertLaneId(value) {
  const laneId = requiredString(value, 'laneId');
  if (!LANE_ID_PATTERN.test(laneId) || laneId.includes('..')) {
    throw new Error(`invalid laneId: ${laneId}`);
  }
  return laneId;
}

function normalizeLiveLaneIds(values) {
  if (!Array.isArray(values)) throw new Error('liveLaneIds must be an array');
  return new Set(values.map((value) => assertLaneId(value)));
}

function assertPathUnderRoot(candidate, root, label) {
  const resolved = path.resolve(candidate);
  const resolvedRoot = path.resolve(root);
  const rel = path.relative(resolvedRoot, resolved);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`${label} must stay under ${resolvedRoot}`);
  }
  return resolved;
}

function parsePorcelainFiles(output) {
  return output
    .split('\n')
    .map((line) => optionalString(line))
    .filter(Boolean)
    .map((line) => {
      const file = line.slice(3);
      const arrow = file.indexOf(' -> ');
      return arrow >= 0 ? file.slice(arrow + 4) : file;
    });
}

function normalizeExecResult(result) {
  if (Array.isArray(result)) {
    return {
      stdout: bufferToString(result[0]),
      stderr: bufferToString(result[1]),
    };
  }
  return {
    stdout: bufferToString(result?.stdout),
    stderr: bufferToString(result?.stderr),
  };
}

function bufferToString(value) {
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  if (value === undefined || value === null) return '';
  return String(value);
}

function positiveTimeout(value) {
  const number = Number(value ?? DEFAULT_GIT_TIMEOUT_MS);
  return Number.isSafeInteger(number) && number > 0 ? number : DEFAULT_GIT_TIMEOUT_MS;
}

function isGitExitError(error) {
  return typeof error?.code === 'number' && ('stdout' in error || 'stderr' in error);
}

function gitErrorMessage(error) {
  return optionalString(error?.stderr) ??
    optionalString(error?.stdout) ??
    optionalString(error?.message) ??
    'git command failed';
}

function isConflictGitOutput(error) {
  const text = `${error.stdout ?? ''}\n${error.stderr ?? ''}`;
  return text.includes('CONFLICT') || text.includes('Automatic merge failed');
}

function isDirtyGitOutput(error) {
  const text = `${error.stdout ?? ''}\n${error.stderr ?? ''}`.toLowerCase();
  return text.includes('local changes') ||
    text.includes('would be overwritten') ||
    text.includes('modified or untracked files') ||
    text.includes('working tree') ||
    text.includes('index.lock');
}

function isMissingWorktreeOutput(error) {
  const text = `${error.stdout ?? ''}\n${error.stderr ?? ''}`.toLowerCase();
  return text.includes('not a working tree') ||
    text.includes('is not a working tree') ||
    text.includes('no such file or directory');
}

function isDataPath(file) {
  return file === 'data' || file.startsWith('data/');
}

async function pathExists(file) {
  try {
    await fs.access(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
