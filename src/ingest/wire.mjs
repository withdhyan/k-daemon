import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  createSubstrateStore,
  exposureDedupeKey,
  requiredString,
} from '../substrate.mjs';

export async function ingestWire(records, surface, options = {}) {
  if (!Array.isArray(records)) {
    throw new Error('records must be an array');
  }

  const store = options.store ?? createSubstrateStore(options.storeOptions);
  const normalizedSurface = requiredString(surface, 'surface');
  const knownDedupeKeys = new Set(
    (await store.listRecords('Exposure')).map((record) => record.dedupeKey),
  );
  const exposures = [];
  let createdCount = 0;
  let duplicateCount = 0;

  for (const record of records) {
    const input = exposureInputForSurface(record, normalizedSurface);
    const dedupeKey = exposureDedupeKey(input);
    const alreadyKnown = knownDedupeKeys.has(dedupeKey);
    const exposure = await store.writeExposure(input);

    exposures.push(exposure);
    if (alreadyKnown) {
      duplicateCount += 1;
    } else {
      createdCount += 1;
      knownDedupeKeys.add(dedupeKey);
    }
  }

  return {
    store,
    surface: normalizedSurface,
    exposures,
    createdCount,
    duplicateCount,
  };
}

export function exposureInputForSurface(record, surface) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error('record must be an object');
  }

  const normalizedSurface = requiredString(surface, 'surface');
  const provenance = {
    ...(record.provenance ?? {}),
    surface: normalizedSurface,
  };

  return {
    ...record,
    provenance,
  };
}

export async function walkIngestDir(dir, predicate, { maxDepth = 4 } = {}) {
  const files = [];
  await walk(dir, 0);
  return files;

  async function walk(currentDir, depth) {
    if (depth > maxDepth) return;

    let entries = [];
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }

    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath, depth + 1);
      } else if (entry.isFile() && predicate(entryPath, entry)) {
        files.push(entryPath);
      }
    }
  }
}
