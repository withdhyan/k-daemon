import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  mindEntityNameContentHash,
  nameMindEntity,
  relabelMindOutputs,
} from './naming.mjs';
import { boundLabel } from './think.mjs';

const fixedNow = () => new Date('2026-07-10T08:09:10.000Z');

test('nameMindEntity forces the sovereign tool schema and caches the model name', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-name-schema-'));
  const calls = [];
  const statements = [
    'Artifact review loops keep returning when K stages mind outputs.',
    'The review loop needs model named labels instead of keyword mashes.',
  ];
  const keywords = ['artifact', 'review', 'loop'];

  const label = await nameMindEntity({
    dataDir,
    now: fixedNow,
    statements,
    keywords,
    fallbackLabel: boundLabel,
    modelCall: async (request) => {
      calls.push(request);
      return { label: 'artifact review loop' };
    },
  });

  assert.equal(label, 'artifact review loop');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].task, 'mind.nameEntity');
  assert.equal(calls[0].tool.name, 'name_mind_entity');
  assert.equal(calls[0].tool.input_schema.additionalProperties, false);
  assert.equal(calls[0].tool.input_schema.properties.label.maxLength, 56);
  assert.match(calls[0].tool.input_schema.properties.label.pattern, /\{1,5\}/);
  assert.match(calls[0].tool.input_schema.properties.label.description, /No verbs-only labels/);
  assert.match(calls[0].system, /2-6 word human noun phrase/);

  const hash = mindEntityNameContentHash({ statements, keywords });
  const cached = JSON.parse(await fs.readFile(
    path.join(dataDir, 'mind', 'names', `${hash}.json`),
    'utf8',
  ));
  assert.equal(cached.label, 'artifact review loop');
  assert.equal(cached.source, 'sovereign-single-call');
});

test('nameMindEntity falls back to boundLabel when the model returns a glued invalid name', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-name-invalid-'));
  const fallback = boundLabel('Hermes configuring path for mind labels');

  const label = await nameMindEntity({
    dataDir,
    now: fixedNow,
    statements: [
      'Hermes configuring path should not become a glued word label.',
    ],
    keywords: ['hermes', 'configuring', 'path'],
    fallbackLabel: () => fallback,
    modelCall: async () => ({ label: 'Hermesconfiguring' }),
  });

  assert.equal(label, fallback);
  assert.deepEqual(await jsonFiles(path.join(dataDir, 'mind', 'names')), []);
});

test('nameMindEntity returns cached names without calling the model again', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-name-cache-'));
  const calls = [];
  const input = {
    dataDir,
    now: fixedNow,
    statements: [
      'Pocket notebook review keeps dropped ideas visible without forcing the queue.',
    ],
    keywords: ['pocket', 'notebook', 'review'],
    fallbackLabel: boundLabel,
  };

  const first = await nameMindEntity({
    ...input,
    modelCall: async (request) => {
      calls.push(request);
      return { label: 'pocket notebook review' };
    },
  });
  const second = await nameMindEntity({
    ...input,
    modelCall: async () => {
      throw new Error('cache miss');
    },
  });

  assert.equal(first, 'pocket notebook review');
  assert.equal(second, 'pocket notebook review');
  assert.equal(calls.length, 1);
});

test('relabelMindOutputs updates live records once and is idempotent', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-name-relabel-'));
  await writeJson(dataDir, path.join('substrate', 'idea-atoms', 'atom_1.json'), {
    id: 'atom_1',
    statement: 'Artifact review loop needs model named labels for mind outputs.',
  });
  await writeJson(dataDir, path.join('substrate', 'mind-outputs', 'mind_1.json'), {
    id: 'mind_1',
    outputId: 'mind_1',
    kind: 'MindTheme',
    outputGroup: 'themes_open_loops',
    outputType: 'themes_open_loops',
    contentHash: 'abc123',
    validTo: null,
    supersededById: null,
    label: 'artifact review labels keyword mash',
    type: 'theme',
    atomIds: ['atom_1'],
    generatedAt: '2026-07-09T00:00:00.000Z',
  });

  const calls = [];
  const modelCall = async (request) => {
    calls.push(request);
    return { label: 'artifact review loop' };
  };

  const first = await relabelMindOutputs({
    dataDir,
    now: fixedNow,
    fallbackLabel: boundLabel,
    modelCall,
  });
  const afterFirst = JSON.parse(await fs.readFile(
    path.join(dataDir, 'substrate', 'mind-outputs', 'mind_1.json'),
    'utf8',
  ));
  const second = await relabelMindOutputs({
    dataDir,
    now: fixedNow,
    fallbackLabel: boundLabel,
    modelCall: async () => {
      throw new Error('idempotence cache miss');
    },
  });

  assert.equal(first.updatedCount, 1);
  assert.equal(first.mutations[0].path, path.join('substrate', 'mind-outputs', 'mind_1.json'));
  assert.equal(afterFirst.label, 'artifact review loop');
  assert.equal(afterFirst.updatedAt, fixedNow().toISOString());
  assert.equal(afterFirst.contentHash, 'abc123');
  assert.equal(calls.length, 1);
  assert.equal(second.updatedCount, 0);
});

async function jsonFiles(dir) {
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  return Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => fs.readFile(path.join(dir, entry.name), 'utf8').then(JSON.parse)));
}

async function writeJson(dataDir, relPath, value) {
  const file = path.join(dataDir, relPath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
