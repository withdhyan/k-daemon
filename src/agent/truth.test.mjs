import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createContradictionRegister,
  detectGlaze,
  EVIDENCE_LEVEL_TO_GRADE,
  gradeEvidence,
} from './truth.mjs';

test('clean output has no glaze hits', () => {
  const report = detectGlaze('hrv: 54ms. third consecutive drop. correlates with late trading sessions.');

  assert.equal(report.score, 0);
  assert.deepEqual(report.hits, []);
});

test('exclamation mark is a minor glaze hit', () => {
  const report = detectGlaze('your recovery is looking good today!');

  assert(report.score > 0);
  assert.deepEqual(
    report.hits.map((hit) => hit.pattern),
    ['exclamation mark'],
  );
  assert.match(report.hits[0].excerpt, /!$/);
});

test('direct praise is detected with the ported pattern list', () => {
  const report = detectGlaze('Great job on your sleep consistency this week!');

  assert(report.score > 0);
  assert(report.hits.some((hit) => hit.pattern === 'direct praise'));
  assert(report.hits.some((hit) => hit.pattern === 'exclamation mark'));
});

test('affirmation is detected with bounded filler-word tolerance', () => {
  const report = detectGlaze('you are really genuinely absolutely right about the caffeine timing.');

  assert(report.hits.some((hit) => hit.pattern === 'unnecessary affirmation'));
  assert.match(report.hits.find((hit) => hit.pattern === 'unnecessary affirmation').excerpt, /right/);
});

test('bounded filler-word tolerance does not cross an unbounded span', () => {
  const report = detectGlaze(
    'you are one two three four five six seven eight nine right about the caffeine timing.',
  );

  assert(!report.hits.some((hit) => hit.pattern === 'unnecessary affirmation'));
});

test('emoji and validating preambles are glaze hits', () => {
  const report = detectGlaze("that's honestly a genuinely good question 🙂");

  assert(report.hits.some((hit) => hit.pattern === 'validating preamble'));
  assert(report.hits.some((hit) => hit.pattern === 'emoji'));
});

test('evidence ladder maps k-core levels to pipeline L grades', () => {
  assert.deepEqual(EVIDENCE_LEVEL_TO_GRADE, {
    ANECDOTE: 'L1',
    SPECULATIVE: 'L1',
    UNKNOWN: 'L1',
    WEAK: 'L2',
    MODERATE: 'L3',
    STRONG: 'L4',
  });
});

test('strong evidence grades L4', () => {
  assert.equal(gradeEvidence([{ replicated: true, mechanistic: true }]), 'L4');
});

test('replicated or mechanistic evidence grades L3', () => {
  assert.equal(gradeEvidence([{ replicated: true }]), 'L3');
  assert.equal(gradeEvidence([{ mechanistic: true }]), 'L3');
});

test('three observations grade L2 while one anecdote grades L1', () => {
  assert.equal(gradeEvidence([{ nObservations: 3 }]), 'L2');
  assert.equal(gradeEvidence([{ nObservations: 1 }]), 'L1');
});

test('explicit evidence grades and levels are preserved at strongest rank', () => {
  assert.equal(gradeEvidence([{ level: 'ANECDOTE' }, { level: 'WEAK' }]), 'L2');
  assert.equal(gradeEvidence([{ grade: 'STRONG' }]), 'L4');
  assert.equal(gradeEvidence([{ evidenceGrade: 'L4' }, { level: 'WEAK' }]), 'L4');
});

test('contradiction register appends records and never overwrites prior claims', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-truth-'));
  const register = createContradictionRegister({
    dataDir,
    now: () => new Date('2026-07-02T10:00:00.000Z'),
  });

  const first = await register.record({
    claimId: 'caffeine-cutoff',
    previous: '2pm cutoff sufficient',
    current: '1pm cutoff needed based on 7-day data',
    reason: 'sleep performance improved after moving cutoff earlier',
  });
  const second = await register.record({
    claimId: 'caffeine-cutoff',
    previous: '1pm cutoff needed based on 7-day data',
    current: 'no caffeine after noon on heavy training days',
    changedAt: '2026-07-03T11:00:00.000Z',
    reason: 'new training-day sleep samples superseded the prior cutoff',
  });

  assert.equal(first.changedAt, '2026-07-02T10:00:00.000Z');
  assert.equal(second.changedAt, '2026-07-03T11:00:00.000Z');

  const records = await register.list({ claimId: 'caffeine-cutoff' });
  assert.equal(records.length, 2);
  assert.equal(records[0].current, '1pm cutoff needed based on 7-day data');
  assert.equal(records[1].previous, '1pm cutoff needed based on 7-day data');

  const lines = (await fs.readFile(register.file, 'utf8')).trim().split('\n');
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]), first);
  assert.deepEqual(JSON.parse(lines[1]), second);
});
