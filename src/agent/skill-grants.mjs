// U6 — the skills loader, own-lean form.
//
// Hermes SKILL.md packages assume the Hermes runtime (shell, `ddgs` CLI,
// execute_code). We never execute foreign code; instead, an APPROVED staged
// skill maps to grants of daemon-NATIVE tools that implement the skill's
// contract. Activation is therefore: founder approves via the staged-skills
// gate (loopback-only) → the mapping below grants the corresponding tool ids
// → the chat route advertises + executes them through the governed loop.
// Skills without a native mapping stay approved-but-inert (no runtime here).
//
// SEC-007: skill records are read exclusively through StagedSkillsStore
// (safeDataPath-locked to data/staged-skills; client path fields rejected).

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { safeDataPath } from '../../daemon/run.mjs';
import {
  STAGED_SKILLS_DIR,
  createStagedSkillsStore,
} from '../ingest/hermes-staging.mjs';
import { isPlainObject, optionalString } from '../substrate.mjs';

// skill name → native tool ids its approval grants.
export const SKILL_TOOL_GRANTS = Object.freeze({
  'duckduckgo-search': Object.freeze(['web.search', 'web.fetch']),
});

export const DEFAULT_TOOL_GRANTS = Object.freeze(['memory.search']);
export const TOOL_GRANTS_POLICY_FILE = path.join(STAGED_SKILLS_DIR, 'tool-grants.json');

/**
 * Compute the active tool grants from founder-approved staged skills.
 *
 * @returns {Promise<Set<string>>} granted native tool ids.
 */
export async function loadSkillGrants({ dataDir, now, store } = {}) {
  const skillsStore = store ?? createStagedSkillsStore({ dataDir, now });
  const resolvedDataDir = path.resolve(dataDir ?? skillsStore.dataDir ?? path.join(process.cwd(), 'data'));
  const grants = new Set(DEFAULT_TOOL_GRANTS);
  for (const toolId of await withheldToolGrants({ dataDir: resolvedDataDir })) {
    grants.delete(toolId);
  }

  let skills;
  try {
    skills = await skillsStore.listSkills();
  } catch {
    return grants; // no staging area yet → default local read grants only.
  }

  for (const record of skills) {
    if (record?.status !== 'approved' || record?.validTo || record?.supersededById) continue;
    for (const toolId of SKILL_TOOL_GRANTS[record.name] ?? []) {
      grants.add(toolId);
    }
  }

  return grants;
}

async function withheldToolGrants({ dataDir }) {
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(safeDataPath(dataDir, TOOL_GRANTS_POLICY_FILE), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    return DEFAULT_TOOL_GRANTS;
  }
  if (!isPlainObject(parsed)) return [];

  return [
    ...stringList(parsed.withheld),
    ...stringList(parsed.withheldTools),
    ...stringList(parsed.deny),
    ...stringList(parsed.denied),
    ...stringList(parsed.revoked),
  ];
}

function stringList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => optionalString(item)).filter(Boolean);
}
