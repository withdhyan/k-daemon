import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { createSubstrateStore } from '../substrate.mjs';
import { ingestWire } from './wire.mjs';
import { xBookmarkToExposure } from './x-bookmarks-live.mjs';

export const X_BOOKMARKS_SURFACE = 'x-bookmarks';

const execFileAsync = promisify(execFile);
const DEFAULT_BOOKMARK_LIMIT = 100;
const XURL_MAX_BUFFER = 32 * 1024 * 1024;
const AUTH_STATUS_ARGS = Object.freeze(['auth', 'status']);
const NO_AUTH_MESSAGE =
  'ingest-x-bookmarks-xurl: xurl auth status reports no usable auth; run xurl auth status locally to diagnose';
const NO_BOOKMARKS_MESSAGE =
  'ingest-x-bookmarks-xurl: xurl returned no usable bookmarks';

export async function ingestXBookmarksViaXurl(options = {}) {
  const store = options.store ?? createSubstrateStore(options.storeOptions);
  const runXurl = typeof options.runXurl === 'function' ? options.runXurl : runXurlCommand;

  try {
    const authStatus = unwrapStdout(await runXurl(AUTH_STATUS_ARGS));
    if (!xurlAuthStatusLooksUsable(authStatus)) {
      return skippedResult(store, {
        reason: 'no-auth',
        message: NO_AUTH_MESSAGE,
      });
    }

    const limit = bookmarkLimit(options.n ?? options.limit ?? options.count);
    const payload = unwrapStdout(await runXurl(['bookmarks', '-n', String(limit)]));
    const entries = parseXurlBookmarks(payload);
    if (entries.length === 0) {
      return skippedResult(store, {
        reason: 'no-bookmarks',
        message: NO_BOOKMARKS_MESSAGE,
      });
    }

    const records = entries
      .map((entry) => xBookmarkToExposure(entry))
      .filter(Boolean);
    if (records.length === 0) {
      return skippedResult(store, {
        reason: 'no-bookmarks',
        message: NO_BOOKMARKS_MESSAGE,
      });
    }

    const result = await ingestWire(records, X_BOOKMARKS_SURFACE, { ...options, store });
    return {
      ...result,
      skipped: false,
    };
  } catch (error) {
    return skippedResult(store, skipForError(error));
  }
}

export function parseXurlBookmarks(json) {
  const payload = parseJsonLike(json);
  const tweets = xurlTweets(payload);
  const usersById = includedUsersById(payload);

  return tweets
    .map((tweet) => xurlTweetToEntry(tweet, usersById))
    .filter(Boolean);
}

async function runXurlCommand(args) {
  const { stdout } = await execFileAsync('xurl', args, {
    encoding: 'utf8',
    maxBuffer: XURL_MAX_BUFFER,
  });
  return stdout;
}

function xurlTweetToEntry(tweet, usersById) {
  if (!isPlainObject(tweet)) return undefined;

  const text = primitiveString(tweet.text ?? tweet.full_text ?? tweet.fullText);
  if (!text) return undefined;

  const id = primitiveString(tweet.id ?? tweet.id_str);
  const authorHandle = authorHandleForTweet(tweet, usersById);
  const url = tweetUrl(tweet, { id, authorHandle });
  const createdAt = primitiveString(tweet.created_at ?? tweet.createdAt);

  return {
    ...(id ? { id } : {}),
    text,
    ...(authorHandle ? { authorHandle } : {}),
    ...(url ? { url } : {}),
    ...(createdAt ? { createdAt } : {}),
  };
}

function xurlTweets(payload) {
  if (Array.isArray(payload)) return payload;
  if (!isPlainObject(payload)) return [];
  if (Array.isArray(payload.data)) return payload.data;
  if (isPlainObject(payload.data)) return [payload.data];
  return [];
}

function includedUsersById(payload) {
  const usersById = new Map();
  if (!isPlainObject(payload) || !Array.isArray(payload.includes?.users)) {
    return usersById;
  }

  for (const user of payload.includes.users) {
    if (!isPlainObject(user)) continue;
    const id = primitiveString(user.id);
    if (id) usersById.set(id, user);
  }
  return usersById;
}

function authorHandleForTweet(tweet, usersById) {
  const direct = authorHandleFromValue(
    tweet.authorHandle ??
      tweet.author_handle ??
      tweet.username ??
      tweet.screen_name ??
      tweet.screenName ??
      tweet.handle ??
      tweet.author ??
      tweet.user,
  );
  if (direct) return direct;

  const authorId = primitiveString(tweet.author_id ?? tweet.authorId);
  return authorHandleFromValue(authorId ? usersById.get(authorId) : undefined);
}

function authorHandleFromValue(value) {
  const direct = primitiveString(value);
  if (direct) return stripAtPrefix(direct);
  if (!isPlainObject(value)) return undefined;

  return stripAtPrefix(
    primitiveString(value.username) ??
      primitiveString(value.screen_name) ??
      primitiveString(value.screenName) ??
      primitiveString(value.handle) ??
      primitiveString(value.name),
  );
}

function tweetUrl(tweet, { id, authorHandle }) {
  const direct = primitiveString(
    tweet.url ??
      tweet.tweet_url ??
      tweet.tweetUrl ??
      tweet.permalink ??
      tweet.permalink_url,
  );
  if (direct) return direct;
  if (!id) return undefined;
  if (authorHandle && /^[A-Za-z0-9_]{1,15}$/.test(authorHandle)) {
    return `https://x.com/${authorHandle}/status/${id}`;
  }
  return `https://x.com/i/web/status/${id}`;
}

function parseJsonLike(value) {
  const unwrapped = unwrapStdout(value);
  if (Buffer.isBuffer(unwrapped)) return parseJsonLike(unwrapped.toString('utf8'));
  if (typeof unwrapped === 'string') {
    const source = unwrapped.replace(/^\uFEFF/, '').trim();
    return source ? JSON.parse(source) : {};
  }
  if (Array.isArray(unwrapped) || isPlainObject(unwrapped)) return unwrapped;
  return {};
}

function xurlAuthStatusLooksUsable(value) {
  const text = outputText(value).trim();
  if (!text) return false;

  const lower = text.toLowerCase();
  if (/"(?:authenticated|authorized|valid)"\s*:\s*true/i.test(text)) return true;
  if (/"(?:authenticated|authorized|valid)"\s*:\s*false/i.test(text)) return false;
  if (/(?:not authenticated|unauthenticated|not authorized|no auth|no apps|no credentials|no tokens|no default|not configured)/i.test(text)) {
    return false;
  }

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const defaultIndex = lines.findIndex((line) => line.includes('\u25b8'));
  if (defaultIndex >= 0) {
    const defaultOauth2Line = lines
      .slice(defaultIndex, defaultIndex + 5)
      .find((line) => /\boauth2\s*:/i.test(line));
    if (defaultOauth2Line) return oauth2LineLooksUsable(defaultOauth2Line);
  }

  const oauth2Lines = lines.filter((line) => /\boauth2\s*:/i.test(line));
  if (oauth2Lines.length > 0) {
    return oauth2Lines.some((line) => oauth2LineLooksUsable(line));
  }

  return !/\b(?:oauth1|oauth2|token)\s*:\s*(?:\(none\)|none|null|missing|not configured|-)\b/i.test(lower);
}

function oauth2LineLooksUsable(line) {
  return !/\boauth2\s*:\s*(?:\(none\)|none|null|missing|not configured|-)?\s*$/i.test(line);
}

function bookmarkLimit(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_BOOKMARK_LIMIT;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return DEFAULT_BOOKMARK_LIMIT;
  return Math.max(1, Math.floor(numeric));
}

function outputText(value) {
  const unwrapped = unwrapStdout(value);
  if (unwrapped === undefined || unwrapped === null) return '';
  if (Buffer.isBuffer(unwrapped)) return unwrapped.toString('utf8');
  if (typeof unwrapped === 'string') return unwrapped;
  return JSON.stringify(unwrapped);
}

function unwrapStdout(value) {
  if (isPlainObject(value) && Object.hasOwn(value, 'stdout')) return value.stdout;
  return value;
}

function skipForError(error) {
  if (error?.code === 'ENOENT') {
    return {
      reason: 'xurl-not-installed',
      message: 'ingest-x-bookmarks-xurl: xurl command not found',
    };
  }
  return {
    reason: 'xurl-command-failed',
    message: 'ingest-x-bookmarks-xurl: xurl command failed',
  };
}

function skippedResult(store, { reason, message }) {
  return {
    store,
    skipped: true,
    reason,
    message,
    surface: X_BOOKMARKS_SURFACE,
    exposures: [],
    createdCount: 0,
    duplicateCount: 0,
  };
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

  const text = String(value).trim();
  return text || undefined;
}

function stripAtPrefix(value) {
  const text = primitiveString(value);
  return text?.startsWith('@') ? text.slice(1) : text;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
