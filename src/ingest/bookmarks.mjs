import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  optionalString,
  requiredString,
} from '../substrate.mjs';
import { ingestWire } from './wire.mjs';

const CHROME_EPOCH_OFFSET_MICROS = 11644473600000000n;

export const BOOKMARKS_FILE = fileURLToPath(
  new URL('../../data/ingest/bookmarks-brave-default.json', import.meta.url),
);

export async function ingestBookmarks(options = {}) {
  const payload = await loadBookmarks(options.file);
  const records = bookmarkExposureRecords(payload);
  return ingestWire(records, options.surface ?? 'chrome', options);
}

export async function loadBookmarks(file = BOOKMARKS_FILE) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

export function bookmarkExposureRecords(payload) {
  const source = requiredString(payload?.source ?? 'bookmarks', 'source');
  const ingestedAt = timestampToIso(payload?.ingested_at);
  return extractBookmarks(payload).map((bookmark, index) =>
    bookmarkToExposure(bookmark, { source, ingestedAt, index }),
  );
}

export function bookmarkToExposure(bookmark, { source, ingestedAt, index }) {
  const title = requiredString(bookmark.name ?? bookmark.title, 'bookmark.name');
  const url = requiredString(bookmark.url, 'bookmark.url');
  const folder = optionalString(bookmark.folder) ?? 'bookmarks';
  const added = optionalString(bookmark.added);
  const eventAt = chromeTimestampToIso(added);

  return {
    type: 'reference',
    statement: `${title} - ${url}`,
    sourceId: bookmarkSourceId({ source, added, folder, url, index }),
    eventAt,
    ingestedAt,
    context: folder,
    provenance: { surface: 'chrome', lane: 'deliberate' },
  };
}

export function extractBookmarks(payload) {
  if (Array.isArray(payload?.items)) {
    return payload.items.filter((item) => item?.url);
  }

  if (payload?.roots && typeof payload.roots === 'object') {
    return Object.entries(payload.roots).flatMap(([rootName, root]) =>
      flattenBookmarkNode(root, rootName),
    );
  }

  return flattenBookmarkNode(payload, '');
}

function flattenBookmarkNode(node, folder) {
  if (!node || typeof node !== 'object') return [];

  if (node.url) {
    return [
      {
        folder: optionalString(node.folder) ?? folder,
        name: node.name ?? node.title,
        url: node.url,
        added: node.date_added ?? node.added,
      },
    ];
  }

  const nextFolder = node.name ? joinFolder(folder, node.name) : folder;
  const children = Array.isArray(node.children) ? node.children : [];
  return children.flatMap((child) => flattenBookmarkNode(child, nextFolder));
}

function bookmarkSourceId({ source, added, folder, url, index }) {
  return [
    'bookmark',
    source,
    added ?? `row-${index}`,
    folder,
    url,
  ].join(':');
}

function chromeTimestampToIso(value) {
  const timestamp = optionalString(value);
  if (!timestamp) return undefined;
  if (!/^-?\d+$/.test(timestamp)) return undefined;

  const micros = BigInt(timestamp);
  const millis = Number((micros - CHROME_EPOCH_OFFSET_MICROS) / 1000n);
  const date = new Date(millis);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`bookmark.added must be a valid Chrome timestamp: ${value}`);
  }

  return date.toISOString();
}

function timestampToIso(value) {
  const timestamp = optionalString(value);
  if (!timestamp) return undefined;

  const withZone = /(?:z|[+-]\d\d:\d\d)$/i.test(timestamp)
    ? timestamp
    : `${timestamp}Z`;
  const date = new Date(withZone);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`timestamp must be a valid date: ${value}`);
  }

  return date.toISOString();
}

function joinFolder(parent, child) {
  const normalizedParent = optionalString(parent);
  const normalizedChild = optionalString(child);
  if (!normalizedParent) return normalizedChild ?? '';
  if (!normalizedChild) return normalizedParent;
  return `${normalizedParent}/${normalizedChild}`;
}
