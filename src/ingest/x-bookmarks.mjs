import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { safeDataPath } from '../../daemon/run.mjs';
import {
  createSubstrateStore,
  optionalString,
  requiredString,
} from '../substrate.mjs';
import { ingestWire } from './wire.mjs';

export const X_BOOKMARKS_SURFACE = 'x-bookmarks';
export const X_BOOKMARK_STATEMENT_MAX_CHARS = 280;
export const X_BOOKMARKS_FILE = safeDataPath(
  '/',
  path.join('ai', 'context dump', 'x_bookmarks_export.json'),
);
export const X_BOOKMARKS_NO_EXPORT_MESSAGE =
  `ingest-bookmarks-x: no X bookmarks export found at ${X_BOOKMARKS_FILE} - pass a file or create /ai/context dump/x_bookmarks_export.json`;

const TEXT_PATHS = Object.freeze([
  ['text'],
  ['full_text'],
  ['fullText'],
  ['tweetText'],
  ['tweet', 'text'],
  ['tweet', 'full_text'],
  ['tweet', 'fullText'],
  ['tweet', 'legacy', 'full_text'],
  ['legacy', 'full_text'],
  ['note_tweet', 'note_tweet_results', 'result', 'text'],
  ['tweet', 'note_tweet', 'note_tweet_results', 'result', 'text'],
  ['content', 'itemContent', 'tweet_results', 'result', 'legacy', 'full_text'],
  ['content', 'itemContent', 'tweet_results', 'result', 'note_tweet', 'note_tweet_results', 'result', 'text'],
  ['item', 'content', 'tweet', 'text'],
]);

const ID_PATHS = Object.freeze([
  ['id'],
  ['id_str'],
  ['tweet_id'],
  ['tweetId'],
  ['rest_id'],
  ['tweet', 'id'],
  ['tweet', 'id_str'],
  ['tweet', 'tweet_id'],
  ['tweet', 'tweetId'],
  ['tweet', 'rest_id'],
  ['tweet', 'legacy', 'id_str'],
  ['legacy', 'id_str'],
  ['content', 'itemContent', 'tweet_results', 'result', 'rest_id'],
  ['content', 'itemContent', 'tweet_results', 'result', 'legacy', 'id_str'],
]);

const URL_PATHS = Object.freeze([
  ['url'],
  ['tweet_url'],
  ['tweetUrl'],
  ['permalink'],
  ['permalink_url'],
  ['expandedUrl'],
  ['expanded_url'],
  ['tweet', 'url'],
  ['tweet', 'tweet_url'],
  ['tweet', 'tweetUrl'],
  ['tweet', 'permalink'],
  ['tweet', 'expandedUrl'],
  ['tweet', 'expanded_url'],
  ['tweet', 'entities', 'urls', 0, 'expanded_url'],
  ['tweet', 'entities', 'urls', 0, 'expandedUrl'],
  ['legacy', 'entities', 'urls', 0, 'expanded_url'],
  ['entities', 'urls', 0, 'expanded_url'],
]);

const AUTHOR_PATHS = Object.freeze([
  ['author'],
  ['authorName'],
  ['authorUsername'],
  ['username'],
  ['screen_name'],
  ['screenName'],
  ['handle'],
  ['tweet', 'author'],
  ['tweet', 'authorName'],
  ['tweet', 'authorUsername'],
  ['tweet', 'username'],
  ['tweet', 'screen_name'],
  ['tweet', 'screenName'],
  ['tweet', 'user'],
  ['tweet', 'legacy', 'user'],
  ['user'],
  ['user_results', 'result'],
  ['core', 'user_results', 'result'],
  ['content', 'itemContent', 'tweet_results', 'result', 'core', 'user_results', 'result'],
]);

const CREATED_AT_PATHS = Object.freeze([
  ['created_at'],
  ['createdAt'],
  ['timestamp'],
  ['tweet', 'created_at'],
  ['tweet', 'createdAt'],
  ['tweet', 'legacy', 'created_at'],
  ['legacy', 'created_at'],
  ['content', 'itemContent', 'tweet_results', 'result', 'legacy', 'created_at'],
]);

export async function ingestXBookmarks(options = {}) {
  const store = options.store ?? createSubstrateStore(options.storeOptions);
  const file = safeExternalPath(options.file ?? options.path ?? X_BOOKMARKS_FILE, 'X bookmarks file');

  if (!await fileExists(file)) {
    return skippedResult(store, { file });
  }

  const payload = await loadXBookmarks(file);
  const records = xBookmarkExposureRecords(payload);
  const result = await ingestWire(records, X_BOOKMARKS_SURFACE, { ...options, store });
  return {
    ...result,
    file,
    skipped: false,
  };
}

export async function loadXBookmarks(file = X_BOOKMARKS_FILE) {
  const resolvedFile = safeExternalPath(file, 'X bookmarks file');
  return parseXBookmarksJson(await fs.readFile(resolvedFile, 'utf8'), resolvedFile);
}

export function parseXBookmarksJson(text, file = 'X bookmarks export') {
  const source = stripByteOrderMark(String(text ?? '')).trim();
  try {
    return JSON.parse(source);
  } catch (firstError) {
    const jsonSlice = extractJsonSlice(source);
    if (jsonSlice && jsonSlice !== source) {
      try {
        return JSON.parse(jsonSlice);
      } catch {
        // Fall through to the original parse error for the clearest location.
      }
    }
    throw new Error(`X bookmarks export must be valid JSON: ${file}: ${firstError.message}`);
  }
}

export function xBookmarkExposureRecords(payload) {
  return extractXBookmarks(payload).map((bookmark, index) =>
    xBookmarkToExposure(bookmark, { index }),
  );
}

export function extractXBookmarks(payload) {
  const records = [];
  const seen = new Set();

  visit(payload);
  return records;

  function visit(value) {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }

    if (!isPlainObject(value)) return;

    const bookmark = normalizeXBookmark(value);
    if (bookmark) {
      const key = xBookmarkIdentity(bookmark);
      if (!seen.has(key)) {
        seen.add(key);
        records.push(bookmark);
      }
      return;
    }

    for (const child of Object.values(value)) visit(child);
  }
}

export function xBookmarkToExposure(bookmark, { index = 0 } = {}) {
  const text = requiredString(bookmark?.text, 'bookmark.text');
  const statement = boundTweetText(text);
  const tweetId = primitiveString(bookmark.id);
  const author = primitiveString(bookmark.author);
  const url = primitiveString(bookmark.url) ?? urlFromAuthorAndId(author, tweetId);
  const identity = tweetId ?? url ?? contentHash([author, text].filter(Boolean).join('\n'));
  const hash = contentHash(text);
  const metadata = {
    contentHash: hash,
    sourceIndex: index,
  };

  if (tweetId) metadata.tweetId = tweetId;
  if (author) metadata.author = author;
  if (url) metadata.url = url;

  return {
    type: 'reference',
    statement,
    sourceId: `${X_BOOKMARKS_SURFACE}:${identity}`,
    eventAt: timestampToIso(bookmark.createdAt),
    context: bookmarkContext({ author, url }),
    provenance: { surface: X_BOOKMARKS_SURFACE, lane: 'deliberate' },
    frontierExcluded: true,
    metadata,
  };
}

export function boundTweetText(value, maxChars = X_BOOKMARK_STATEMENT_MAX_CHARS) {
  const text = optionalString(String(value ?? '').replace(/\s+/g, ' '));
  if (!text) return undefined;
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function normalizeXBookmark(value) {
  const text = firstPathString(value, TEXT_PATHS);
  if (!text) return null;

  const id = firstPathString(value, ID_PATHS);
  const author = firstAuthor(value);
  const url = firstPathString(value, URL_PATHS) ?? urlFromAuthorAndId(author, id);
  const createdAt = firstPathString(value, CREATED_AT_PATHS);
  const hasTweetSignal = Boolean(id || author || url || hasKnownTweetKey(value));
  if (!hasTweetSignal) return null;

  return {
    text,
    ...(id ? { id } : {}),
    ...(author ? { author } : {}),
    ...(url ? { url } : {}),
    ...(createdAt ? { createdAt } : {}),
  };
}

function firstAuthor(value) {
  for (const pathParts of AUTHOR_PATHS) {
    const author = authorString(pathValue(value, pathParts));
    if (author) return author;
  }
  return undefined;
}

function firstPathString(value, paths) {
  for (const pathParts of paths) {
    const text = primitiveString(pathValue(value, pathParts));
    if (text) return text;
  }
  return undefined;
}

function pathValue(value, pathParts) {
  let current = value;
  for (const part of pathParts) {
    if (current === undefined || current === null) return undefined;
    current = current[part];
  }
  return current;
}

function authorString(value) {
  const direct = primitiveString(value);
  if (direct) return stripAtPrefix(direct);
  if (!isPlainObject(value)) return undefined;

  const legacy = isPlainObject(value.legacy) ? value.legacy : undefined;
  return stripAtPrefix(
    primitiveString(value.screen_name) ??
      primitiveString(value.screenName) ??
      primitiveString(value.username) ??
      primitiveString(value.handle) ??
      primitiveString(value.name) ??
      primitiveString(legacy?.screen_name) ??
      primitiveString(legacy?.screenName) ??
      primitiveString(legacy?.username) ??
      primitiveString(legacy?.name),
  );
}

function primitiveString(value) {
  if (value === undefined || value === null) return undefined;
  if (
    typeof value !== 'string' &&
    typeof value !== 'number' &&
    typeof value !== 'bigint' &&
    typeof value !== 'boolean'
  ) {
    return undefined;
  }
  return optionalString(value);
}

function hasKnownTweetKey(value) {
  return [
    'tweet',
    'legacy',
    'tweet_results',
    'itemContent',
    'full_text',
    'fullText',
    'tweetText',
  ].some((key) => Object.hasOwn(value, key));
}

function bookmarkContext({ author, url }) {
  return [author, url].filter(Boolean).join(' - ') || X_BOOKMARKS_SURFACE;
}

function xBookmarkIdentity(bookmark) {
  return bookmark.id ?? bookmark.url ?? contentHash([bookmark.author, bookmark.text].filter(Boolean).join('\n'));
}

function urlFromAuthorAndId(author, id) {
  const screenName = stripAtPrefix(author);
  if (!screenName || !id || !/^[A-Za-z0-9_]{1,15}$/.test(screenName)) return undefined;
  return `https://x.com/${screenName}/status/${id}`;
}

function stripAtPrefix(value) {
  const text = primitiveString(value);
  return text?.startsWith('@') ? text.slice(1) : text;
}

function contentHash(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex');
}

function timestampToIso(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return undefined;
    return dateToIso(new Date(Math.abs(value) < 100000000000 ? value * 1000 : value));
  }

  const text = primitiveString(value);
  if (!text) return undefined;
  if (/^-?\d+(?:\.\d+)?$/.test(text)) {
    const numeric = Number(text);
    if (!Number.isFinite(numeric)) return undefined;
    return dateToIso(new Date(Math.abs(numeric) < 100000000000 ? numeric * 1000 : numeric));
  }

  const direct = dateToIso(new Date(text));
  if (direct) return direct;

  const withZone = /(?:z|[+-]\d\d:?\d\d)$/i.test(text) ? text : `${text}Z`;
  return dateToIso(new Date(withZone));
}

function dateToIso(date) {
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

function extractJsonSlice(source) {
  const objectStart = source.indexOf('{');
  const arrayStart = source.indexOf('[');
  const starts = [objectStart, arrayStart].filter((index) => index >= 0);
  if (starts.length === 0) return undefined;

  const start = Math.min(...starts);
  const objectEnd = source.lastIndexOf('}');
  const arrayEnd = source.lastIndexOf(']');
  const end = Math.max(objectEnd, arrayEnd);
  return end >= start ? source.slice(start, end + 1) : undefined;
}

function stripByteOrderMark(value) {
  return String(value ?? '').replace(/^\uFEFF/, '');
}

async function fileExists(file) {
  try {
    return (await fs.stat(file)).isFile();
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function safeExternalPath(value, label) {
  const resolved = path.resolve(requiredString(value, label));
  const rel = path.relative('/', resolved);
  if (!rel) throw new Error(`refused unsafe data path: ${value}`);
  return safeDataPath('/', rel);
}

function skippedResult(store, { file }) {
  return {
    store,
    file,
    skipped: true,
    message: X_BOOKMARKS_NO_EXPORT_MESSAGE,
    surface: X_BOOKMARKS_SURFACE,
    exposures: [],
    createdCount: 0,
    duplicateCount: 0,
  };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
