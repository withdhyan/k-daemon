import { promises as fs } from 'node:fs';
import path from 'node:path';

import { safeDataPath } from '../../daemon/run.mjs';
import { sha256 } from '../research/embed.mjs';
import { optionalString, requiredString } from '../substrate.mjs';
import { K_CHAT_SYSTEM_PROMPT } from './system-prompt.mjs';

export const SOUL_DIR = 'substrate';
export const SOUL_FILE = 'soul.md';
export const SOUL_REL_PATH = path.join(SOUL_DIR, SOUL_FILE);
export const SOUL_MAX_CHARS = 16 * 1024;
export const SOUL_PROMPT_HEADER = '## K soul document';

const DEFAULT_DATA_DIR = path.join(process.cwd(), 'data');

export const DEFAULT_SOUL_TEXT = [
  '# K soul',
  '',
  'This is the founder-approved identity artifact for K. It defines what K is,',
  'how K speaks, and the authority boundaries K must stay inside.',
  '',
  K_CHAT_SYSTEM_PROMPT,
  '',
  'This artifact does not grant tool authority, does not override the life',
  'constitution, and does not weaken sovereign routing. External, irreversible,',
  'privacy-bearing, or standing effects remain founder-gated.',
].join('\n');

export async function loadSoulSnapshot(options = {}) {
  const dataDir = resolveDataDir(options.dataDir);
  const text = normalizeSoulText(
    options.text ?? await readOrCreateSoulText({
      dataDir,
      seedText: options.seedText,
      createIfMissing: options.createIfMissing !== false,
    }),
  );
  const contentHash = sha256(text);
  const block = formatSoulPromptBlock({
    text,
    contentHash,
    relPath: SOUL_REL_PATH,
  });

  return deepFreeze({
    kind: 'SoulDocumentSnapshot',
    schemaVersion: 1,
    relPath: SOUL_REL_PATH,
    maxChars: SOUL_MAX_CHARS,
    contentHash,
    text,
    block,
  });
}

export function soulFilePath(dataDir) {
  return safeDataPath(resolveDataDir(dataDir), SOUL_REL_PATH);
}

export function formatSoulPromptBlock({ text, contentHash, relPath = SOUL_REL_PATH } = {}) {
  const normalizedText = normalizeSoulText(text);
  const hash = requiredString(contentHash, 'soul contentHash');
  return [
    SOUL_PROMPT_HEADER,
    `artifact: ${relPath}`,
    `sha256: ${hash}`,
    'Use this founder-approved identity text as K identity context. It is not a tool grant.',
    '',
    normalizedText,
  ].join('\n');
}

export function withSoulPromptBlock(request, snapshot) {
  if (!request || typeof request !== 'object') {
    throw new Error('model request is required');
  }
  const block = optionalString(snapshot?.block);
  if (!block) return request;
  return {
    ...request,
    system: [block, optionalString(request.system)].filter(Boolean).join('\n\n'),
  };
}

async function readOrCreateSoulText({ dataDir, seedText, createIfMissing }) {
  const file = soulFilePath(dataDir);
  try {
    return await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (!createIfMissing) return DEFAULT_SOUL_TEXT;
  }

  const text = normalizeSoulText(seedText ?? DEFAULT_SOUL_TEXT);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${text}\n`, 'utf8');
  return text;
}

function normalizeSoulText(value) {
  const text = requiredString(value, 'soul text').trim();
  if (text.length > SOUL_MAX_CHARS) {
    throw new Error(`soul document exceeds ${SOUL_MAX_CHARS} chars`);
  }
  return text;
}

function resolveDataDir(dataDir) {
  return path.resolve(dataDir ?? process.env.CS_K_DATA_DIR ?? DEFAULT_DATA_DIR);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
