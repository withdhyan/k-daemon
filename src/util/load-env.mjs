import { promises as fs } from 'node:fs';
import path from 'node:path';

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export async function loadEnvLocal(rootDir) {
  const file = path.join(path.resolve(rootDir), '.env.local');
  let source;
  try {
    source = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return Object.freeze({ loaded: false, assignedCount: 0 });
    }
    throw error;
  }

  let assignedCount = 0;
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;

    const key = trimmed.slice(0, separator).trim();
    if (!ENV_KEY_PATTERN.test(key) || Object.hasOwn(process.env, key)) continue;

    process.env[key] = trimmed.slice(separator + 1);
    assignedCount += 1;
  }

  return Object.freeze({ loaded: true, assignedCount });
}
