import { createHash } from 'node:crypto';

import {
  createSubstrateStore,
  optionalString,
} from '../substrate.mjs';
import { ingestWire } from './wire.mjs';
import { boundTweetText } from './x-bookmarks.mjs';

export const X_BOOKMARKS_SURFACE = 'x-bookmarks';
export const X_BOOKMARKS_LIVE_NO_ENTRIES_MESSAGE =
  'ingest-x-bookmarks-live: no harvested X bookmarks provided';

export function xBookmarkToExposure(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined;

  const text = normalizedText(entry.text);
  const statement = boundTweetText(text);
  if (!statement) return undefined;

  const id = primitiveString(entry.id);
  const url = primitiveString(entry.url);
  const authorHandle = primitiveString(entry.authorHandle);
  const eventAt = timestampToIso(entry.createdAt);
  const contentHash = contentSha256(text);

  return {
    type: 'reference',
    statement,
    sourceId: [
      X_BOOKMARKS_SURFACE,
      id ?? url,
      contentHash,
    ].join(':'),
    ...(eventAt ? { eventAt } : {}),
    context: authorHandle,
    provenance: { surface: X_BOOKMARKS_SURFACE, lane: 'deliberate' },
    frontierExcluded: true,
    metadata: {
      url,
      authorHandle,
    },
  };
}

export async function ingestXBookmarksLive(entries, options = {}) {
  const store = options.store ?? createSubstrateStore(options.storeOptions);

  if (!Array.isArray(entries) || entries.length === 0) {
    return skippedResult(store);
  }

  const records = entries
    .map((entry) => xBookmarkToExposure(entry))
    .filter(Boolean);
  const result = await ingestWire(records, X_BOOKMARKS_SURFACE, { ...options, store });
  return {
    ...result,
    skipped: false,
  };
}

function normalizedText(value) {
  if (
    value === undefined ||
    value === null ||
    (
      typeof value !== 'string' &&
      typeof value !== 'number' &&
      typeof value !== 'bigint' &&
      typeof value !== 'boolean'
    )
  ) {
    return undefined;
  }
  return optionalString(String(value).replace(/\s+/g, ' '));
}

function primitiveString(value) {
  if (
    value === undefined ||
    value === null ||
    (
      typeof value !== 'string' &&
      typeof value !== 'number' &&
      typeof value !== 'bigint' &&
      typeof value !== 'boolean'
    )
  ) {
    return undefined;
  }
  return optionalString(value);
}

function contentSha256(value) {
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

function skippedResult(store) {
  return {
    store,
    skipped: true,
    message: X_BOOKMARKS_LIVE_NO_ENTRIES_MESSAGE,
    surface: X_BOOKMARKS_SURFACE,
    exposures: [],
    createdCount: 0,
    duplicateCount: 0,
  };
}
