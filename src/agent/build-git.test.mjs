import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  GIT_PATH,
  checkpoint,
  integrate,
  laneWorktreeAdd,
  laneWorktreeRemove,
  pruneWorktrees,
  recoverIntegration,
} from './build-git.mjs';

const execFileAsync = promisify(execFile);

test('worktree add/remove/prune keeps live-id worktrees and removes stale entries', async () => {
  const repoRoot = await fixtureRepo();
  const baseSha = await git(repoRoot, ['rev-parse', 'HEAD']);

  const live = await laneWorktreeAdd({ repoRoot, laneId: 'live', baseSha });
  const stale = await laneWorktreeAdd({ repoRoot, laneId: 'stale', baseSha });

  assert.equal(await pathExists(live.path), true);
  assert.equal(await pathExists(stale.path), true);

  const pruned = await pruneWorktrees({
    repoRoot,
    liveLaneIds: ['live'],
    isGitProcessRunningImpl: async () => false,
  });

  assert.equal(pruned.ok, true);
  assert.deepEqual(pruned.removed.map((entry) => entry.laneId), ['stale']);
  assert.equal(await pathExists(live.path), true);
  assert.equal(await pathExists(stale.path), false);

  const removed = await laneWorktreeRemove({ repoRoot, laneId: 'live', force: true });
  assert.equal(removed.ok, true);
  assert.equal(removed.removed, true);
  assert.equal(await pathExists(live.path), false);
});

test('checkpoint returns HEAD and integrate clean merge on unchanged base does not require re-gate', async () => {
  const repoRoot = await fixtureRepo();
  const baseSha = await git(repoRoot, ['rev-parse', 'HEAD']);
  const lane = await laneWorktreeAdd({ repoRoot, laneId: 'clean', baseSha });

  await writeFile(path.join(lane.path, 'feature.txt'), 'lane feature\n');
  await git(lane.path, ['add', 'feature.txt']);
  await git(lane.path, ['commit', '-m', 'lane feature']);

  const mark = await checkpoint({ repoRoot });
  assert.equal(mark.ok, true);
  assert.equal(mark.sha, baseSha);

  const result = await integrate({
    repoRoot,
    laneWorktree: lane.path,
    baseShaAtGate: baseSha,
  });

  assert.equal(result.ok, true);
  assert.equal(result.regateRequired, false);
  assert.equal(result.sha, await git(repoRoot, ['rev-parse', 'HEAD']));
  assert.equal(await fs.readFile(path.join(repoRoot, 'feature.txt'), 'utf8'), 'lane feature\n');
});

test('base advanced after gate integrates cleanly and returns regateRequired true', async () => {
  const repoRoot = await fixtureRepo();
  const baseSha = await git(repoRoot, ['rev-parse', 'HEAD']);
  const lane = await laneWorktreeAdd({ repoRoot, laneId: 'advanced', baseSha });

  await writeFile(path.join(lane.path, 'lane.txt'), 'lane change\n');
  await git(lane.path, ['add', 'lane.txt']);
  await git(lane.path, ['commit', '-m', 'lane change']);

  await writeFile(path.join(repoRoot, 'main.txt'), 'main advanced\n');
  await git(repoRoot, ['add', 'main.txt']);
  await git(repoRoot, ['commit', '-m', 'main advanced']);
  const advancedSha = await git(repoRoot, ['rev-parse', 'HEAD']);

  const result = await integrate({
    repoRoot,
    laneWorktree: lane.path,
    baseShaAtGate: baseSha,
  });

  assert.equal(result.ok, true);
  assert.equal(result.baseSha, advancedSha);
  assert.equal(result.regateRequired, true);
  assert.equal(await fs.readFile(path.join(repoRoot, 'lane.txt'), 'utf8'), 'lane change\n');
});

test('textual conflict returns structured conflict and leaves repo clean at original HEAD', async () => {
  const repoRoot = await fixtureRepo();
  const baseSha = await git(repoRoot, ['rev-parse', 'HEAD']);
  const lane = await laneWorktreeAdd({ repoRoot, laneId: 'conflict', baseSha });

  await writeFile(path.join(lane.path, 'README.md'), 'lane edit\n');
  await git(lane.path, ['add', 'README.md']);
  await git(lane.path, ['commit', '-m', 'lane edit']);

  await writeFile(path.join(repoRoot, 'README.md'), 'main edit\n');
  await git(repoRoot, ['add', 'README.md']);
  await git(repoRoot, ['commit', '-m', 'main edit']);
  const headBefore = await git(repoRoot, ['rev-parse', 'HEAD']);

  const result = await integrate({
    repoRoot,
    laneWorktree: lane.path,
    baseShaAtGate: baseSha,
  });

  assert.equal(result.ok, false);
  assert.equal(result.conflict, true);
  assert.deepEqual(result.files, ['README.md']);
  assert.equal(result.regateRequired, true);
  assert.equal(await git(repoRoot, ['rev-parse', 'HEAD']), headBefore);
  assert.equal(await pathExists(path.join(await gitDir(repoRoot), 'MERGE_HEAD')), false);
  assert.equal(await pathExists(path.join(await gitDir(repoRoot), 'index.lock')), false);
  assert.deepEqual(await git(repoRoot, ['status', '--porcelain']), '');
});

test('recoverIntegration restores checkpoint sha and removes merge/index artifacts', async () => {
  const repoRoot = await fixtureRepo();
  const mark = await checkpoint({ repoRoot });

  await writeFile(path.join(repoRoot, 'after.txt'), 'after checkpoint\n');
  await git(repoRoot, ['add', 'after.txt']);
  await git(repoRoot, ['commit', '-m', 'after checkpoint']);
  await writeFile(path.join(repoRoot, 'README.md'), 'dirty tracked change\n');

  const repoGitDir = await gitDir(repoRoot);
  await writeFile(path.join(repoGitDir, 'MERGE_HEAD'), `${await git(repoRoot, ['rev-parse', 'HEAD'])}\n`);
  await writeFile(path.join(repoGitDir, 'index.lock'), '');

  const recovered = await recoverIntegration({
    repoRoot,
    checkpointSha: mark.sha,
  });

  assert.equal(recovered.ok, true);
  assert.equal(recovered.found.mergeHead, path.join(repoGitDir, 'MERGE_HEAD'));
  assert.equal(recovered.found.indexLock, path.join(repoGitDir, 'index.lock'));
  assert.equal(recovered.found.dirty, true);
  assert.equal(await git(repoRoot, ['rev-parse', 'HEAD']), mark.sha);
  assert.equal(await pathExists(path.join(repoGitDir, 'MERGE_HEAD')), false);
  assert.equal(await pathExists(path.join(repoGitDir, 'index.lock')), false);
  assert.deepEqual(await git(repoRoot, ['status', '--porcelain', '--untracked-files=no']), '');
});

test('lane changes under data are refused before integration touches them', async () => {
  const repoRoot = await fixtureRepo();
  const baseSha = await git(repoRoot, ['rev-parse', 'HEAD']);
  const lane = await laneWorktreeAdd({ repoRoot, laneId: 'data-guard', baseSha });

  await fs.mkdir(path.join(lane.path, 'data'), { recursive: true });
  await writeFile(path.join(lane.path, 'data', 'secret.txt'), 'do not integrate\n');
  await git(lane.path, ['add', '-f', 'data/secret.txt']);
  await git(lane.path, ['commit', '-m', 'data change']);

  const result = await integrate({
    repoRoot,
    laneWorktree: lane.path,
    baseShaAtGate: baseSha,
  });

  assert.equal(result.ok, false);
  assert.equal(result.protectedPath, true);
  assert.deepEqual(result.files, ['data/secret.txt']);
  assert.equal(await pathExists(path.join(repoRoot, 'data', 'secret.txt')), false);
  assert.equal(await git(repoRoot, ['rev-parse', 'HEAD']), baseSha);
});

async function fixtureRepo() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-build-git-'));
  await git(dir, ['init']);
  await git(dir, ['config', 'user.email', 'builder@example.test']);
  await git(dir, ['config', 'user.name', 'Build Runner']);
  await writeFile(path.join(dir, '.gitignore'), '/data/\n');
  await writeFile(path.join(dir, 'README.md'), 'base\n');
  await git(dir, ['add', '.gitignore', 'README.md']);
  await git(dir, ['commit', '-m', 'initial']);
  return dir;
}

async function git(cwd, args) {
  const result = await execFileAsync(GIT_PATH, args, {
    cwd,
    maxBuffer: 16 * 1024 * 1024,
  });
  return String(result.stdout ?? '').trim();
}

async function gitDir(repoRoot) {
  const location = await git(repoRoot, ['rev-parse', '--git-dir']);
  return path.isAbsolute(location) ? path.resolve(location) : path.resolve(repoRoot, location);
}

async function writeFile(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, 'utf8');
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
