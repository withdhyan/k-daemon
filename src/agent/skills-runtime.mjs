import { createStagedSkillsStore } from '../ingest/hermes-staging.mjs';
import { isPlainObject, optionalString } from '../substrate.mjs';
import { SKILL_TOOL_GRANTS } from './skill-grants.mjs';

const AUTONOMOUS = Object.freeze({ class: 'autonomous' });
const SKILLS_HEADER =
  'If a skill matches or is even partially relevant to the request, you MUST load it with skill.view(name) before answering. ' +
  'This applies to CAPABILITIES too: before building, improvising, or reaching for an external tool/API/integration, check the skill index FIRST — a maintained skill (e.g. an official CLI wrapper) beats a hand-built client.';
const DESCRIPTION_LIMIT = 60;
const CLIENT_PATH_ERROR = 'path_traversal';
const CLIENT_PATH_FIELDS = Object.freeze(['path', 'file', 'filePath', 'relPath', 'targetPath', 'skillPath']);

const INJECTION_PATTERNS = Object.freeze([
  Object.freeze({ code: 'ignore_instructions', pattern: /\b(ignore|disregard|override)\b.{0,80}\b(previous|prior|system|developer)\b.{0,40}\binstructions?\b/i }),
  Object.freeze({ code: 'reveal_system_prompt', pattern: /\b(reveal|print|show|dump|exfiltrate)\b.{0,80}\b(system|developer)\b.{0,40}\b(prompt|message|instructions?)\b/i }),
  Object.freeze({ code: 'change_tool_policy', pattern: /\b(disable|bypass|ignore|override)\b.{0,80}\b(tool|safety|approval|permission|policy|guardrail)\b/i }),
]);

export const SKILLS_RUNTIME_TOOLS = Object.freeze([
  Object.freeze({
    id: 'skills.list',
    toolset: 'skills',
    summary: 'List approved live skills available for progressive disclosure.',
    readOnly: true,
    risk: AUTONOMOUS,
    parameters: {
      type: 'object',
      properties: {},
    },
  }),
  Object.freeze({
    id: 'skill.view',
    toolset: 'skills',
    summary: 'Read the full raw body of one approved staged skill by name.',
    readOnly: true,
    risk: AUTONOMOUS,
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Approved staged skill name' },
      },
      required: ['name'],
    },
  }),
]);

export async function buildSkillsIndex({ dataDir, now, store } = {}) {
  const skills = await approvedLiveSkills({ dataDir, now, store });
  const lines = ['## Skills', SKILLS_HEADER];

  for (const skill of skills) {
    lines.push(renderSkillIndexLine(skill));
  }

  return lines.join('\n');
}

export async function viewSkill(input = {}) {
  const options = isPlainObject(input) ? input : {};
  const { dataDir, name, now, store } = options;

  if (hasClientPathField(options)) {
    return refuse(CLIENT_PATH_ERROR);
  }

  const skillName = optionalString(name);
  if (!skillName) return refuse('skill_not_found');

  const skillsStore = store ?? createStagedSkillsStore({ dataDir, now });
  const liveMatches = (await skillsStore.listSkills())
    .filter(isLiveSkill)
    .filter((record) => record.name === skillName);

  if (liveMatches.length === 0) return refuse('skill_not_found');

  const approvedMatches = liveMatches.filter((record) => record.status === 'approved');
  if (approvedMatches.length === 0) {
    return refuse('skill_not_approved');
  }
  if (approvedMatches.length > 1) return refuse('ambiguous_skill');

  const candidate = approvedMatches[0];

  const record = await skillsStore.readSkill(candidate.skillId);
  if (!record || !isLiveSkill(record) || record.status !== 'approved') {
    return refuse('skill_not_approved');
  }

  const rawBody = typeof record.rawBody === 'string' ? record.rawBody : '';
  const warning = scanSkillInjectionWarning(rawBody);
  if (warning) {
    console.warn('[skills-runtime] possible prompt injection in approved skill', {
      skillId: record.skillId,
      name: record.name,
      warning,
    });
  }

  return {
    ok: true,
    skillId: record.skillId,
    name: record.name,
    rawBody,
    ...(warning ? { warning } : {}),
  };
}

export async function executeSkillsRuntimeTool(toolId, args = {}, { dataDir, now, store } = {}) {
  if (toolId === 'skills.list') {
    const skills = await skillsMetadata({ dataDir, now, store });
    const index = await buildSkillsIndex({ dataDir, now, store });
    return {
      toolId,
      ok: true,
      skills,
      index,
      output: JSON.stringify({ index, skills }, null, 2),
    };
  }

  if (toolId === 'skill.view') {
    const payload = isPlainObject(args) ? args : {};
    if (hasClientPathField(payload)) {
      return { toolId, ok: false, reason: CLIENT_PATH_ERROR };
    }
    const result = await viewSkill({
      dataDir,
      now,
      store,
      name: payload.name,
    });
    if (!result.ok) {
      return { toolId, ok: false, reason: result.error };
    }
    return {
      toolId,
      ok: true,
      skillId: result.skillId,
      name: result.name,
      output: result.rawBody,
      ...(result.warning ? { warning: result.warning } : {}),
    };
  }

  return { toolId, ok: false, reason: 'unknown_tool' };
}

export async function skillsMetadata({ dataDir, now, store } = {}) {
  const skills = await approvedLiveSkills({ dataDir, now, store });
  return skills.map((record) => ({
    skillId: record.skillId,
    name: record.name,
    description: truncateDescription(record.description),
    toolsActive: hasActiveToolGrant(record.name),
    declaredTools: Array.isArray(record.declaredTools) ? record.declaredTools : [],
  }));
}

export function scanSkillInjectionWarning(rawBody) {
  const source = optionalString(rawBody) ?? '';
  const matches = INJECTION_PATTERNS
    .filter(({ pattern }) => pattern.test(source))
    .map(({ code }) => code);

  if (matches.length === 0) return null;
  return Object.freeze({
    code: 'possible_prompt_injection',
    matches: Object.freeze(matches),
  });
}

async function approvedLiveSkills({ dataDir, now, store } = {}) {
  const skillsStore = store ?? createStagedSkillsStore({ dataDir, now });
  return (await skillsStore.listSkills())
    .filter((record) => isLiveSkill(record) && record.status === 'approved');
}

function renderSkillIndexLine(record) {
  const suffix = hasActiveToolGrant(record.name) ? ' [tools active]' : '';
  return `- ${record.name}: ${truncateDescription(record.description)}${suffix}`;
}

function truncateDescription(value) {
  return (optionalString(value) ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, DESCRIPTION_LIMIT);
}

function hasActiveToolGrant(name) {
  return Object.hasOwn(SKILL_TOOL_GRANTS, name);
}

function isLiveSkill(record) {
  return isPlainObject(record) && !record.validTo && !record.supersededById;
}

function hasClientPathField(value) {
  return isPlainObject(value) && CLIENT_PATH_FIELDS.some((field) => Object.hasOwn(value, field));
}

function refuse(error) {
  return Object.freeze({ ok: false, error });
}

export { DESCRIPTION_LIMIT, SKILLS_HEADER };
