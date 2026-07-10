import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { safeDataPath } from '../../daemon/run.mjs';
import { requiredString } from '../substrate.mjs';

export const DEFAULT_EMBEDDING_MODEL = 'nomic-embed-text';
export const OLLAMA_EMBEDDINGS_URL = 'http://127.0.0.1:11434/api/embeddings';

const CACHE_SCHEMA_VERSION = 1;
const DEFAULT_OLLAMA_TIMEOUT_MS = 20_000;

export async function embed(text, opts = {}) {
  const prompt = requiredEmbeddingString(text);
  const {
    model,
    textHash,
    cacheKey,
    cacheFile,
  } = embeddingCacheMetadata(prompt, opts);
  const cached = await readCachedEmbedding(cacheFile, { model });
  if (cached) return cached;

  // opts.embedder is a test-only injection seam; production uses localhost Ollama.
  const embedding = normalizeEmbedding(
    opts.embedder
      ? await opts.embedder(prompt, { model })
      : await ollamaEmbed(prompt, {
          model,
          fetchImpl: opts.fetchImpl,
          timeoutMs: opts.timeoutMs,
        }),
  );

  await writeCachedEmbedding(cacheFile, {
    schemaVersion: CACHE_SCHEMA_VERSION,
    cacheKey,
    textHash,
    model,
    embedding,
  });

  return embedding;
}

export async function embedRecord(record, opts = {}) {
  if (!record || typeof record !== 'object') {
    throw new Error('record is required');
  }

  switch (record.kind) {
    case 'Exposure':
      return embed(requiredEmbeddingString(record.statement, 'Exposure.statement'), opts);
    case 'SelfPattern':
      return embed(requiredEmbeddingString(record.pattern, 'SelfPattern.pattern'), opts);
    default:
      throw new Error(`unsupported embeddable record kind: ${record.kind ?? 'unknown'}`);
  }
}

export function embeddingCacheMetadata(text, opts = {}) {
  const prompt = requiredEmbeddingString(text);
  const model = requiredEmbeddingString(
    opts.model
      ?? process.env.K_EMBED_MODEL
      ?? process.env.OLLAMA_EMBED_MODEL
      ?? DEFAULT_EMBEDDING_MODEL,
    'model',
  );
  const cacheDir = embeddingCacheDir(opts);
  const textHash = sha256(prompt);
  const cacheKey = sha256(`${model}\n${prompt}`);

  return {
    model,
    textHash,
    cacheKey,
    cacheFile: path.join(cacheDir, `${cacheKey}.json`),
  };
}

async function ollamaEmbed(prompt, { model, fetchImpl, timeoutMs }) {
  const fetchFn = fetchImpl ?? globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    throw new Error('fetch is unavailable; pass opts.fetchImpl, or opts.embedder in tests');
  }

  const response = await fetchWithTimeout(fetchFn, OLLAMA_EMBEDDINGS_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, prompt }),
  }, {
    timeoutMs,
    label: 'Ollama embedding request',
  });

  if (!response?.ok) {
    const status = response?.status ? ` ${response.status}` : '';
    const body = response?.text ? await response.text().catch(() => '') : '';
    throw new Error(`Ollama embedding request failed${status}${body ? `: ${body}` : ''}`);
  }

  return response.json();
}

function embeddingCacheDir(opts) {
  const dataDir = path.resolve(
    opts.dataDir ?? process.env.CS_K_DATA_DIR ?? path.join(process.cwd(), 'data'),
  );
  if (opts.cacheDir) {
    const cacheDir = path.resolve(opts.cacheDir);
    return safeDataPath(dataDir, path.relative(dataDir, cacheDir) || '.');
  }
  return safeDataPath(dataDir, 'embeddings');
}

export async function readCachedEmbedding(file, { model }) {
  try {
    const payload = JSON.parse(await fs.readFile(file, 'utf8'));
    if (payload?.model !== model) return null;
    return normalizeEmbedding(payload);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function writeCachedEmbedding(file, payload) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function normalizeEmbedding(value) {
  const embedding = Array.isArray(value) ? value : value?.embedding;
  if (!Array.isArray(embedding)) {
    throw new Error('embedding response must include an embedding array');
  }

  return embedding.map((entry, index) => {
    if (typeof entry !== 'number' || !Number.isFinite(entry)) {
      throw new Error(`embedding[${index}] must be a finite number`);
    }
    return entry;
  });
}

function requiredEmbeddingString(value, label = 'text') {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string`);
  }
  return requiredString(value, label);
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function fetchWithTimeout(fetchFn, url, init, { timeoutMs, label }) {
  const controller = new AbortController();
  const timeout = normalizeTimeoutMs(timeoutMs);
  let timeoutId;

  try {
    return await new Promise((resolve, reject) => {
      timeoutId = setTimeout(() => {
        controller.abort();
        reject(new Error(`${label} timed out after ${timeout}ms`));
      }, timeout);

      Promise.resolve(fetchFn(url, {
        ...init,
        signal: controller.signal,
      })).then(resolve, reject);
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

function normalizeTimeoutMs(value) {
  const number = Number(value ?? DEFAULT_OLLAMA_TIMEOUT_MS);
  return Number.isFinite(number) && number >= 0
    ? Math.floor(number)
    : DEFAULT_OLLAMA_TIMEOUT_MS;
}
