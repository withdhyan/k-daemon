import { createHash } from 'node:crypto';

import {
  optionalString,
  requiredString,
} from '../substrate.mjs';

// ── U7 · Hermes-updates ingest source adapter ────────────────────────────────
// Hermes's public GitHub skills-catalog is treated as a read-only INGEST SOURCE
// (on-thesis with cs-k's ingest model). This module ONLY fetches + parses +
// normalizes into STAGED records. It never writes, never executes, and never
// activates anything — foreign SKILL.md bodies are data until the founder
// approves them (see daemon/routes/staged-skills.mjs + the [auto]-empty gate).
//
// SEC-006 (supply-chain P1): hard byte/line limits on every fetched body; a
// STRICT allow-list front-matter parse (closed set of scalar keys — no
// arbitrary text is executed or eval'd); the parser is a pure function isolated
// from the daemon; the raw body is retained verbatim (bounded) so the approval
// surface can show it in full before any activation.

export const HERMES_INGEST_SURFACE = 'hermes';

// The Hermes skills-catalog repo is EXECUTION-TIME CONFIG, never hardcoded to a
// guess (plan F-07/SG-002). Named via env; falls back to a documented default
// slug the founder can override in .env.local. `owner/repo` on github.com.
export const HERMES_CATALOG_REPO_ENV = 'K_HERMES_CATALOG_REPO';
export const HERMES_CATALOG_REF_ENV = 'K_HERMES_CATALOG_REF';
export const HERMES_CATALOG_PATH_ENV = 'K_HERMES_CATALOG_PATH';
export const HERMES_GITHUB_TOKEN_ENV = 'K_HERMES_GITHUB_TOKEN';

// Documented default; the founder confirms/overrides the real slug in config.
export const DEFAULT_HERMES_CATALOG_REPO = 'NousResearch/hermes-skills';
export const DEFAULT_HERMES_CATALOG_REF = 'main';
export const DEFAULT_HERMES_CATALOG_PATH = 'skills';

export const GITHUB_API_BASE = 'https://api.github.com';

// Hard supply-chain limits (SEC-006). Anything over quarantines, never fatal.
export const MAX_SKILL_BYTES = 64 * 1024; // 64 KiB per SKILL.md body
export const MAX_SKILL_LINES = 2000;
export const MAX_CATALOG_ENTRIES = 500; // bound the tree we will walk
export const MAX_RELEASES = 20;
export const MAX_RELEASE_NOTE_BYTES = 16 * 1024;

const GITHUB_TIMEOUT_MS = 30_000;
// Strict closed allow-list of front-matter keys. A key outside this set is
// dropped (not executed, not stored as a field). Values are always coerced to
// bounded scalar strings — never parsed as code.
const ALLOWED_FRONTMATTER_KEYS = Object.freeze([
  'name',
  'description',
  'version',
  'license',
  'author',
  'homepage',
  'tags',
  'allowed-tools',
]);
const MAX_FRONTMATTER_VALUE_BYTES = 512;
const MAX_FRONTMATTER_LIST_ITEMS = 32;

export function hermesCatalogConfig(env = process.env) {
  const repo = normalizeRepoSlug(
    optionalString(env[HERMES_CATALOG_REPO_ENV]) ?? DEFAULT_HERMES_CATALOG_REPO,
  );
  const ref = optionalString(env[HERMES_CATALOG_REF_ENV]) ?? DEFAULT_HERMES_CATALOG_REF;
  const basePath = normalizeCatalogPath(
    optionalString(env[HERMES_CATALOG_PATH_ENV]) ?? DEFAULT_HERMES_CATALOG_PATH,
  );
  const token = optionalString(env[HERMES_GITHUB_TOKEN_ENV]);
  return { repo, ref, basePath, token };
}

// Pure, isolated parse — the ONLY thing that ever touches a foreign body.
// Returns { ok, staged? , quarantined? }. Never throws on bad input; a
// malformed/oversized skill is quarantined so the caller can surface it without
// crashing the run.
export function parseSkillDocument(raw, meta = {}) {
  const sourcePath = requiredString(meta.path ?? meta.sourcePath, 'skill path');
  if (typeof raw !== 'string') {
    return quarantine(sourcePath, 'not_text', meta);
  }

  const byteLength = Buffer.byteLength(raw, 'utf8');
  if (byteLength > MAX_SKILL_BYTES) {
    return quarantine(sourcePath, 'oversize_bytes', meta, { byteLength });
  }

  const body = stripByteOrderMark(raw);
  const lineCount = body.split(/\r?\n/).length;
  if (lineCount > MAX_SKILL_LINES) {
    return quarantine(sourcePath, 'oversize_lines', meta, { lineCount });
  }

  const { frontmatter, quarantineReason } = parseFrontmatter(body);
  if (quarantineReason) {
    return quarantine(sourcePath, quarantineReason, meta);
  }

  const name = frontmatter.name ?? deriveNameFromPath(sourcePath);
  if (!name) {
    return quarantine(sourcePath, 'missing_name', meta);
  }

  const contentHash = sha256(body);
  const staged = {
    kind: 'StagedSkill',
    schemaVersion: 1,
    surface: HERMES_INGEST_SURFACE,
    skillId: skillIdFor(name),
    name,
    description: frontmatter.description ?? '',
    version: frontmatter.version ?? '',
    license: frontmatter.license ?? '',
    author: frontmatter.author ?? '',
    homepage: frontmatter.homepage ?? '',
    tags: frontmatter.tags ?? [],
    declaredTools: frontmatter['allowed-tools'] ?? [],
    sourcePath,
    sourceRepo: optionalString(meta.repo) ?? '',
    sourceRef: optionalString(meta.ref) ?? '',
    sourceSha: optionalString(meta.sha) ?? '',
    contentHash,
    byteLength,
    lineCount,
    // Full raw body retained verbatim (bounded above) — the approval surface
    // shows this UNsummarized for inspection (SEC-006).
    rawBody: body,
    status: 'pending',
  };

  return { ok: true, staged };
}

export function parseReleaseNote(release) {
  if (!release || typeof release !== 'object') return null;
  const tag = optionalString(release.tag_name ?? release.tag);
  const name = optionalString(release.name) ?? tag;
  if (!tag && !name) return null;

  const bodyRaw = optionalString(release.body) ?? '';
  const body = bodyRaw.length > MAX_RELEASE_NOTE_BYTES
    ? `${bodyRaw.slice(0, MAX_RELEASE_NOTE_BYTES)}\n…[truncated]`
    : bodyRaw;
  const noteId = releaseNoteIdFor(tag ?? name);

  return {
    kind: 'HermesCapabilityNote',
    schemaVersion: 1,
    surface: HERMES_INGEST_SURFACE,
    noteId,
    tag: tag ?? '',
    name: name ?? '',
    publishedAt: optionalString(release.published_at) ?? '',
    url: optionalString(release.html_url) ?? '',
    body,
    contentHash: sha256(`${tag ?? ''}\n${name ?? ''}\n${body}`),
    status: 'pending',
  };
}

// Read-only fetch of the catalog + releases → normalized staged records. The
// caller (daemon verb) diffs these against the persisted staged store and
// writes ONLY through the daemon (daemon-owns-writes). This function performs
// NO writes.
export async function fetchHermesUpdates(options = {}) {
  const env = options.env ?? process.env;
  const config = options.config ?? hermesCatalogConfig(env);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch is unavailable for Hermes ingest');
  }

  const github = createGithubClient(fetchImpl, config.token);

  const treeEntries = await listSkillEntries(github, config);
  const skills = [];
  const quarantined = [];

  for (const entry of treeEntries.slice(0, MAX_CATALOG_ENTRIES)) {
    let raw;
    try {
      raw = await github.getRawText(config.repo, config.ref, entry.path);
    } catch (error) {
      quarantined.push({
        sourcePath: entry.path,
        reason: 'fetch_failed',
        detail: statusOnly(error),
      });
      continue;
    }

    const result = parseSkillDocument(raw, {
      path: entry.path,
      repo: config.repo,
      ref: config.ref,
      sha: entry.sha,
    });
    if (result.ok) {
      skills.push(result.staged);
    } else {
      quarantined.push(result.quarantined);
    }
  }

  let capabilityNotes = [];
  try {
    const releases = await github.listReleases(config.repo);
    capabilityNotes = releases
      .slice(0, MAX_RELEASES)
      .map(parseReleaseNote)
      .filter(Boolean);
  } catch {
    // Release notes are advisory — a missing/failed releases endpoint degrades
    // to "no capability notes", never fails the skill ingest (silence-default).
    capabilityNotes = [];
  }

  return {
    surface: HERMES_INGEST_SURFACE,
    repo: config.repo,
    ref: config.ref,
    basePath: config.basePath,
    skills,
    capabilityNotes,
    quarantined,
    scannedCount: treeEntries.length,
  };
}

async function listSkillEntries(github, config) {
  const tree = await github.getTree(config.repo, config.ref);
  const base = config.basePath ? `${config.basePath}/` : '';
  return tree
    .filter((node) =>
      node.type === 'blob' &&
      typeof node.path === 'string' &&
      isSkillPath(node.path) &&
      (base === '' || node.path.startsWith(base)))
    .map((node) => ({ path: node.path, sha: optionalString(node.sha) ?? '' }));
}

function isSkillPath(entryPath) {
  const lower = entryPath.toLowerCase();
  return lower.endsWith('/skill.md') || lower === 'skill.md';
}

function createGithubClient(fetchImpl, token) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'cs-k-hermes-ingest',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  async function getJson(url) {
    const response = await fetchWithTimeout(fetchImpl, url, { method: 'GET', headers });
    if (!response?.ok) {
      // Status only — never echo GitHub response bodies into logs/errors.
      throw githubError(response?.status);
    }
    return response.json();
  }

  return {
    async getTree(repo, ref) {
      const url = `${GITHUB_API_BASE}/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`;
      const payload = await getJson(url);
      return Array.isArray(payload?.tree) ? payload.tree : [];
    },
    async listReleases(repo) {
      const url = `${GITHUB_API_BASE}/repos/${repo}/releases?per_page=${MAX_RELEASES}`;
      const payload = await getJson(url);
      return Array.isArray(payload) ? payload : [];
    },
    async getRawText(repo, ref, entryPath) {
      const url =
        `https://raw.githubusercontent.com/${repo}/${encodeURIComponent(ref)}/` +
        entryPath.split('/').map(encodeURIComponent).join('/');
      const response = await fetchWithTimeout(fetchImpl, url, {
        method: 'GET',
        headers: { 'User-Agent': 'cs-k-hermes-ingest' },
      }, MAX_SKILL_BYTES);
      if (!response?.ok) throw githubError(response?.status);
      return readBoundedText(response);
    },
  };
}

// Read at most MAX_SKILL_BYTES + a small margin so a hostile huge body cannot
// exhaust memory before the byte-limit check in parseSkillDocument.
async function readBoundedText(response) {
  const limit = MAX_SKILL_BYTES + 1024;
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      chunks.push(value);
      if (size > limit) {
        await reader.cancel();
        break;
      }
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
  }
  const text = await response.text();
  return text.length > limit ? text.slice(0, limit) : text;
}

async function fetchWithTimeout(fetchImpl, url, init, _limit) {
  const controller = new AbortController();
  let timeoutId;
  try {
    return await new Promise((resolve, reject) => {
      timeoutId = setTimeout(() => {
        controller.abort();
        reject(new Error('Hermes fetch timed out'));
      }, GITHUB_TIMEOUT_MS);
      Promise.resolve(fetchImpl(url, { ...init, signal: controller.signal }))
        .then(resolve, reject);
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

// ── strict front-matter parse (no code execution) ───────────────────────────
function parseFrontmatter(body) {
  const lines = body.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') {
    // No front-matter block — allowed; name derives from path.
    return { frontmatter: {} };
  }

  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) return { frontmatter: {}, quarantineReason: 'unterminated_frontmatter' };

  const frontmatter = {};
  let currentListKey = null;

  for (let i = 1; i < end; i += 1) {
    const line = lines[i];
    if (!line.trim()) {
      currentListKey = null;
      continue;
    }

    // YAML-style list item under the previous key ("  - value").
    const listItem = /^\s*-\s+(.*)$/.exec(line);
    if (listItem && currentListKey) {
      appendListValue(frontmatter, currentListKey, listItem[1]);
      continue;
    }

    const kv = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) {
      // Unrecognized structure inside front-matter is ignored, not executed.
      currentListKey = null;
      continue;
    }

    const key = kv[1].toLowerCase();
    if (!ALLOWED_FRONTMATTER_KEYS.includes(key)) {
      currentListKey = null;
      continue; // drop keys outside the closed allow-list
    }

    const isListKey = key === 'tags' || key === 'allowed-tools';
    const rawValue = kv[2].trim();
    if (rawValue === '') {
      // Only list keys open a following block list; an empty scalar stays ''.
      if (isListKey) {
        currentListKey = key;
        frontmatter[key] = [];
      } else {
        currentListKey = null;
        frontmatter[key] = '';
      }
      continue;
    }

    currentListKey = null;
    if (isListKey) {
      frontmatter[key] = parseInlineList(rawValue);
    } else {
      frontmatter[key] = boundScalar(rawValue);
    }
  }

  return { frontmatter };
}

function appendListValue(frontmatter, key, rawItem) {
  if (key !== 'tags' && key !== 'allowed-tools') return;
  const list = Array.isArray(frontmatter[key]) ? frontmatter[key] : [];
  if (list.length >= MAX_FRONTMATTER_LIST_ITEMS) {
    frontmatter[key] = list;
    return;
  }
  const value = boundScalar(unquote(rawItem));
  if (value) list.push(value);
  frontmatter[key] = list;
}

function parseInlineList(rawValue) {
  const inner = rawValue.replace(/^\[/, '').replace(/\]$/, '');
  return inner
    .split(',')
    .map((item) => boundScalar(unquote(item.trim())))
    .filter(Boolean)
    .slice(0, MAX_FRONTMATTER_LIST_ITEMS);
}

function boundScalar(value) {
  const text = unquote(String(value ?? '').trim());
  if (Buffer.byteLength(text, 'utf8') > MAX_FRONTMATTER_VALUE_BYTES) {
    return Buffer.from(text, 'utf8').slice(0, MAX_FRONTMATTER_VALUE_BYTES).toString('utf8');
  }
  return text;
}

function unquote(value) {
  const text = String(value ?? '').trim();
  if (
    (text.startsWith('"') && text.endsWith('"') && text.length >= 2) ||
    (text.startsWith("'") && text.endsWith("'") && text.length >= 2)
  ) {
    return text.slice(1, -1);
  }
  return text;
}

function deriveNameFromPath(sourcePath) {
  const segments = sourcePath.split('/').filter(Boolean);
  if (segments.length >= 2) return segments[segments.length - 2];
  return optionalString(segments[0]?.replace(/\.md$/i, ''));
}

function quarantine(sourcePath, reason, meta, extra = {}) {
  return {
    ok: false,
    quarantined: {
      sourcePath,
      reason,
      repo: optionalString(meta.repo) ?? '',
      ref: optionalString(meta.ref) ?? '',
      sha: optionalString(meta.sha) ?? '',
      ...extra,
    },
  };
}

export function skillIdFor(name) {
  return `skl-${sha256(HERMES_INGEST_SURFACE + '::' + String(name).toLowerCase()).slice(0, 24)}`;
}

export function releaseNoteIdFor(tag) {
  return `cap-${sha256(HERMES_INGEST_SURFACE + '::' + String(tag)).slice(0, 24)}`;
}

function sha256(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function stripByteOrderMark(value) {
  return String(value ?? '').replace(/^﻿/, '');
}

function normalizeRepoSlug(value) {
  const slug = requiredString(value, 'Hermes catalog repo').trim();
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(slug)) {
    throw new Error(`Hermes catalog repo must be "owner/repo": ${slug}`);
  }
  return slug;
}

function normalizeCatalogPath(value) {
  const trimmed = String(value ?? '').trim().replace(/^\/+|\/+$/g, '');
  if (trimmed.split('/').includes('..')) {
    throw new Error(`refused unsafe catalog path: ${value}`);
  }
  return trimmed;
}

function githubError(status) {
  // Status only — never include the GitHub response body.
  const error = new Error(`Hermes GitHub request failed${status ? ` ${status}` : ''}`);
  error.status = status;
  return error;
}

function statusOnly(error) {
  return error && Number.isInteger(error.status) ? String(error.status) : 'error';
}
