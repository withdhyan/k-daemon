import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import {
  CADENCE_REVIEW_CARDS_PATH,
  CADENCE_VALUE_PROBE_ANSWERS_PATH,
  REVIEW_CARD_TYPE_VALUE_PROBE,
  createReviewCadenceStore,
  generateValueProbeCard,
  generateWeeklyRetroCard,
} from './review-cadences.mjs';
import {
  VALUE_ANCHOR_KIND,
  listValueAnchors,
} from './elicitation.mjs';
import {
  CADENCE_RETRO_PATH,
  handleCadenceReviewRoute,
} from '../../daemon/routes/cadence.mjs';

const fixedNow = () => new Date('2026-07-08T10:00:00.000Z');

test('weekly value probe card stages <=3 anti-Barnum forced-choice probes from soul and user model', async () => {
  const dataDir = await tempDataDir();
  await seedSoulAndUserModel(dataDir);

  const result = await generateValueProbeCard({
    dataDir,
    now: fixedNow,
  });

  assert.equal(result.ok, true);
  assert.equal(result.created, true);
  assert.equal(result.card.type, REVIEW_CARD_TYPE_VALUE_PROBE);
  assert.equal(result.card.title, 'value probes');
  assert.equal(result.card.valueProbes.weekStart, '2026-07-06');
  assert(result.card.valueProbes.probes.length > 0);
  assert(result.card.valueProbes.probes.length <= 3);
  assert.equal(result.card.valueProbes.answerAction.path, CADENCE_VALUE_PROBE_ANSWERS_PATH);
  assert.equal(result.card.valueProbes.sourceContext.soul.relPath, path.join('substrate', 'soul.md'));
  assert.equal(result.card.valueProbes.sourceContext.userModel.artifactCount, 1);

  for (const probe of result.card.valueProbes.probes) {
    assert.equal(probe.kind, 'ValueProbe');
    assert.equal(probe.shape, 'which-is-more-you');
    assert.equal(probe.forcedChoice, true);
    assert.equal(probe.antiBarnum.forcedChoice, true);
    assert.equal(probe.antiBarnum.bothOptionsPositive, true);
    assert.equal(probe.options.length, 2);
    assert.notEqual(probe.options[0].value, probe.options[1].value);
  }

  assert(
    result.card.valueProbes.probes.some((probe) =>
      probe.options.some((option) => option.value === 'rich_artifact')),
    'user-model cues should make the richness-vs-lived-proof probe eligible',
  );

  const stored = JSON.parse(await fs.readFile(path.join(dataDir, result.path.replace(/^data\//, '')), 'utf8'));
  assert.equal(stored.kind, 'ReviewCadenceCard');
  assert.equal(stored.type, REVIEW_CARD_TYPE_VALUE_PROBE);
});

test('value probe answers persist as eval layer 3 ValueAnchor records and enrich listed cards', async () => {
  const dataDir = await tempDataDir();
  await seedSoulAndUserModel(dataDir);
  const store = createReviewCadenceStore({ dataDir, now: fixedNow });
  const generated = await store.generateCard(REVIEW_CARD_TYPE_VALUE_PROBE);
  const probe = generated.card.valueProbes.probes[0];
  const selected = probe.options[0];

  const answered = await dispatchRoute({
    dataDir,
    store,
    method: 'POST',
    pathname: CADENCE_VALUE_PROBE_ANSWERS_PATH,
    payload: {
      cardId: generated.card.id,
      answers: [{ probeId: probe.id, selectedOptionId: selected.id }],
    },
  });

  assert.equal(answered.status, 200);
  assert.equal(answered.body.ok, true);
  assert.equal(answered.body.createdCount, 1);
  assert.equal(answered.body.anchors[0].kind, VALUE_ANCHOR_KIND);
  assert.equal(answered.body.anchors[0].cardId, generated.card.id);
  assert.equal(answered.body.anchors[0].probeId, probe.id);
  assert.equal(answered.body.anchors[0].selectedOptionId, selected.id);
  assert.equal(answered.body.anchors[0].evalLayer, 3);
  assert.equal(answered.body.anchors[0].eval.signal, 'forced-choice-value-anchor');

  const repeated = await dispatchRoute({
    dataDir,
    store,
    method: 'POST',
    pathname: CADENCE_VALUE_PROBE_ANSWERS_PATH,
    payload: {
      cardId: generated.card.id,
      answers: [{ probeId: probe.id, selectedOptionId: selected.id }],
    },
  });
  assert.equal(repeated.status, 200);
  assert.equal(repeated.body.createdCount, 0);

  const anchors = await listValueAnchors({ dataDir, cardId: generated.card.id });
  assert.equal(anchors.length, 1);
  assert.equal(anchors[0].rejectedOptionId, probe.options[1].id);

  const listed = await dispatchRoute({
    dataDir,
    store,
    method: 'GET',
    pathname: CADENCE_REVIEW_CARDS_PATH,
    query: { type: REVIEW_CARD_TYPE_VALUE_PROBE },
  });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.count, 1);
  assert.equal(listed.body.cards[0].valueProbes.answeredCount, 1);
  assert.equal(listed.body.cards[0].valueProbes.probes[0].answer.anchorId, anchors[0].id);

  const retro = await generateWeeklyRetroCard({ dataDir, now: fixedNow });
  assert.equal(retro.card.retro.evalHealth.valueAnchors.evalLayer, 3);
  assert.equal(retro.card.retro.evalHealth.valueAnchors.anchorCount, 1);
  assert.deepEqual(retro.card.retro.evalHealth.valueAnchors.axes, [probe.axis]);

  const retroRoute = await dispatchRoute({
    dataDir,
    store,
    method: 'GET',
    pathname: CADENCE_RETRO_PATH,
  });
  assert.equal(retroRoute.status, 200);
  assert.equal(retroRoute.body.retro.evalHealth.valueAnchors.anchorCount, 1);
});

test('value probe route rejects answers that do not match the staged forced-choice options', async () => {
  const dataDir = await tempDataDir();
  await seedSoulAndUserModel(dataDir);
  const store = createReviewCadenceStore({ dataDir, now: fixedNow });
  const generated = await store.generateCard(REVIEW_CARD_TYPE_VALUE_PROBE);
  const probe = generated.card.valueProbes.probes[0];

  const result = await dispatchRoute({
    dataDir,
    store,
    method: 'POST',
    pathname: CADENCE_VALUE_PROBE_ANSWERS_PATH,
    payload: {
      cardId: generated.card.id,
      answers: [{ probeId: probe.id, selectedOptionId: 'not-an-option' }],
    },
  });

  assert.equal(result.status, 400);
  assert.deepEqual(result.body, { ok: false, error: 'invalid_value_probe_answer' });
});

async function seedSoulAndUserModel(dataDir) {
  await writeText(dataDir, path.join('substrate', 'soul.md'), [
    '# K soul',
    '',
    'K is local, sovereign, advisory, and silence-default.',
    'K frees attention and keeps consequential steps human-gated.',
  ].join('\n'));
  await writeText(dataDir, path.join('substrate', 'user-model.md'), [
    '# User model',
    '',
    'The founder repeatedly says to preserve richness, artifact detail, and recoverable intent.',
    'The model should still be checked against lived proof, cadence, and the footprint of actual weeks.',
    'Richness and artifact preservation are live user-model cues, not generic personality traits.',
  ].join('\n'));
}

async function tempDataDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-elicitation-'));
}

async function writeText(dataDir, relPath, value) {
  const file = path.join(dataDir, relPath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${value.trim()}\n`, 'utf8');
}

async function dispatchRoute(input) {
  const response = mockResponse();
  const deps = routeDeps();
  try {
    await handleCadenceReviewRoute(
      mockRequest(input.payload),
      response,
      {
        method: input.method,
        pathname: input.pathname,
        dataDir: input.dataDir,
        now: fixedNow,
        reviewCadenceStore: input.store,
        searchParams: new URLSearchParams(input.query ?? {}),
      },
      deps,
    );
  } catch (error) {
    deps.sendJson(response, error.statusCode ?? 500, {
      ok: false,
      error: error.expose ? error.code : 'server_error',
    });
  }
  return {
    status: response.statusCode,
    body: JSON.parse(response.body),
  };
}

function routeDeps() {
  return {
    sendJson(response, statusCode, body) {
      response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
      response.end(`${JSON.stringify(body)}\n`);
    },
    httpError(statusCode, code) {
      const error = new Error(code);
      error.statusCode = statusCode;
      error.code = code;
      error.expose = true;
      return error;
    },
    readPlaintextJson: async (request) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    },
  };
}

function mockRequest(payload) {
  if (payload === undefined) return Readable.from([]);
  return Readable.from([Buffer.from(JSON.stringify(payload), 'utf8')]);
}

function mockResponse() {
  return {
    statusCode: null,
    body: '',
    writeHead(statusCode) {
      this.statusCode = statusCode;
    },
    end(chunk) {
      if (chunk) this.body += String(chunk);
    },
  };
}
