import { createHash } from 'node:crypto';

import { parseSkillDocument } from '../ingest/hermes.mjs';
import {
  STAGED_SKILLS_DIR,
  createStagedSkillsStore,
} from '../ingest/hermes-staging.mjs';
import {
  isPlainObject,
  optionalString,
  requiredString,
} from '../substrate.mjs';
import { DESCRIPTION_LIMIT } from './skills-runtime.mjs';

const AUTONOMOUS_STAGED = Object.freeze({ class: 'gated', reason: 'capability_grant' });
const LEARN_ACTIONS = Object.freeze(['create', 'edit']);
const REQUIRED_SECTIONS = Object.freeze([
  'When-to-Use',
  'Prerequisites',
  'How-to-Run',
  'Quick-Reference',
  'Procedure',
  'Pitfalls',
  'VERIFICATION',
]);
const PROVENANCE_HEADING = 'Provenance';
const DEFAULT_SOURCE_PATH = 'learn/draft/SKILL.md';
const DIFF_PREVIEW_LINES = 40;

// TODO(GA integration lane): advertise LEARN_TOOLS in the governed chat tool
// inventory and route `skill.manage` calls to executeLearnTool.
export const LEARN_TOOLS = Object.freeze([
  Object.freeze({
    id: 'skill.manage',
    toolset: 'skills',
    summary: 'Create or edit a K-authored SKILL.md candidate as pending staged data only.',
    readOnly: false,
    risk: AUTONOMOUS_STAGED,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: LEARN_ACTIONS,
          description: 'create or edit only; delete is not supported in GA-5',
        },
        rawBody: {
          type: 'string',
          description: 'Complete drafted SKILL.md body to validate and stage',
        },
      },
      required: ['action', 'rawBody'],
    },
  }),
]);

export function buildLearnPrompt({ request, sources } = {}) {
  const requestText = requiredString(request, 'learn request');
  const normalizedSources = normalizeSources(sources);
  const lines = [
    'You are drafting exactly one K SKILL.md from a /learn request.',
    'Return only the complete SKILL.md. Do not include commentary outside the file.',
    '',
    'HARDLINE STANDARDS:',
    '- Frontmatter must include name, description, and author.',
    `- description <=60 chars. The skills index truncates at ${DESCRIPTION_LIMIT}; anything past char 60 never routes.`,
    "- author: K. Always use K; never use the OS username or local account name for privacy.",
    '- Body sections must appear in this exact order:',
    '  When-to-Use -> Prerequisites -> How-to-Run -> Quick-Reference -> Procedure -> Pitfalls -> VERIFICATION',
    '- VERIFICATION is mandatory and must make the skill falsifiable.',
    '- Add a Provenance block after VERIFICATION with source paths, URLs, or conversation refs.',
    '- Use K tool vocabulary: say skill.view and web.fetch; never cat or curl.',
    '- Do not request active grants, approvals, or writes outside staged skills.',
    '',
    'Required shape:',
    '---',
    'name: short-kebab-name',
    'description: <=60 chars, routeable from the index',
    'author: K',
    'allowed-tools:',
    '  - skill.view',
    '  - web.fetch',
    '---',
    '',
    '## When-to-Use',
    '## Prerequisites',
    '## How-to-Run',
    '## Quick-Reference',
    '## Procedure',
    '## Pitfalls',
    '## VERIFICATION',
    '## Provenance',
    '',
    'Request:',
    requestText,
    '',
    'Sources:',
  ];

  if (normalizedSources.length === 0) {
    lines.push('- conversation: current /learn request only');
  } else {
    for (const source of normalizedSources) {
      lines.push(`<source label="${source.label}">`);
      lines.push(source.text);
      lines.push('</source>');
    }
  }

  return lines.join('\n');
}

export function validateLearnSkill(rawBody, options = {}) {
  const body = rawString(rawBody);
  if (!body || body.trim().length === 0) return invalid('missing_raw_body');

  const parsed = parseSkillDocument(body, { path: options.sourcePath ?? DEFAULT_SOURCE_PATH });
  if (!parsed.ok) {
    return invalid(parsed.quarantined?.reason ?? 'invalid_skill_document');
  }

  const metadata = parsed.staged;
  const description = normalizeDescription(metadata.description);
  if (!description) return invalid('missing_description');
  if (description.length > DESCRIPTION_LIMIT) {
    return invalid('description_too_long', { limit: DESCRIPTION_LIMIT, actual: description.length });
  }

  if ((optionalString(metadata.author) ?? '') !== 'K') {
    return invalid('author_not_k');
  }

  const sectionCheck = checkRequiredSectionOrder(body);
  if (!sectionCheck.ok) return invalid(sectionCheck.reason, sectionCheck.detail);

  if (!hasProvenanceBlock(body)) {
    return invalid('missing_provenance');
  }

  if (usesNonKToolVocabulary(body)) {
    return invalid('non_k_tool_vocabulary');
  }

  return Object.freeze({
    ok: true,
    metadata: Object.freeze({
      name: metadata.name,
      description,
      version: metadata.version,
      license: metadata.license,
      author: metadata.author,
      homepage: metadata.homepage,
      tags: metadata.tags,
      declaredTools: metadata.declaredTools,
    }),
  });
}

export async function executeLearnTool(toolId, args = {}, options = {}) {
  if (toolId !== 'skill.manage') {
    return { toolId, ok: false, reason: 'unknown_tool' };
  }

  const payload = isPlainObject(args) ? args : {};
  const action = optionalString(payload.action);
  if (!LEARN_ACTIONS.includes(action)) {
    return { toolId, ok: false, reason: 'unsupported_action' };
  }

  const rawBody = rawString(payload.rawBody ?? payload.body ?? payload.content);
  const result = await stageLearnSkill({
    action,
    rawBody,
    sourcePath: optionalString(payload.sourcePath),
    dataDir: options.dataDir,
    now: options.now,
    store: options.store,
  });

  if (!result.ok) {
    return { toolId, ok: false, reason: result.reason, ...(result.detail ? { detail: result.detail } : {}) };
  }

  const response = {
    action,
    skillId: result.skillId,
    pendingPath: result.pendingPath,
    status: result.status,
    outcome: result.outcome,
    contentHash: result.contentHash,
  };

  return {
    toolId,
    ok: true,
    ...response,
    output: JSON.stringify(response, null, 2),
  };
}

export async function runLearn({ request, gather, draft, stage, dataDir, now, store } = {}) {
  const requestText = requiredString(request, 'learn request');
  const gatherFn = typeof gather === 'function' ? gather : async () => [];
  if (typeof draft !== 'function') {
    throw new Error('learn draft function is required');
  }

  const sources = normalizeSources(await gatherFn({ request: requestText }));
  const prompt = buildLearnPrompt({ request: requestText, sources });
  const rawBody = draftRawBody(await draft({ request: requestText, sources, prompt }));
  const validation = validateLearnSkill(rawBody);
  if (!validation.ok) return validation;

  const stagedInput = buildStagedSkillInput(rawBody, validation.metadata);
  const stageFn = typeof stage === 'function'
    ? stage
    : async (input) => {
        const skillsStore = store ?? createStagedSkillsStore({ dataDir, now });
        return skillsStore.stageSkill(input);
      };
  const staged = await stageFn(stagedInput);
  const record = staged?.record ?? staged;
  if (!isPlainObject(record)) {
    throw new Error('learn stage function must return a staged record');
  }

  return learnRunResult(record, validation.metadata.description, rawBody);
}

export async function stageLearnSkill({
  rawBody,
  sourcePath,
  dataDir,
  now,
  store,
} = {}) {
  const validation = validateLearnSkill(rawBody, { sourcePath });
  if (!validation.ok) return validation;

  const stagedInput = buildStagedSkillInput(rawBody, validation.metadata, { sourcePath });
  const skillsStore = store ?? createStagedSkillsStore({ dataDir, now });
  const staged = await skillsStore.stageSkill(stagedInput);
  const record = staged.record;

  return {
    ok: true,
    skillId: record.skillId,
    pendingPath: pendingPathFor(record.skillId),
    status: record.status,
    outcome: staged.outcome,
    contentHash: record.contentHash,
    record,
  };
}

export function learnSkillIdFor(name) {
  return `skl-${sha256(requiredString(name, 'skill name')).slice(0, 24)}`;
}

export function contentHashFor(rawBody) {
  return sha256(requiredRawString(rawBody, 'rawBody'));
}

export function diffPreviewFor(rawBody, limit = DIFF_PREVIEW_LINES) {
  return requiredRawString(rawBody, 'rawBody')
    .split(/\r?\n/)
    .slice(0, limit)
    .map((line) => `+${line}`)
    .join('\n');
}

function buildStagedSkillInput(rawBody, metadata, options = {}) {
  const name = requiredString(metadata.name, 'skill name');
  const sourcePath = optionalString(options.sourcePath) ?? sourcePathForName(name);
  return {
    kind: 'StagedSkill',
    schemaVersion: 1,
    surface: 'k-authored',
    skillId: learnSkillIdFor(name),
    name,
    description: metadata.description,
    version: optionalString(metadata.version) ?? '',
    license: optionalString(metadata.license) ?? '',
    author: 'K',
    homepage: optionalString(metadata.homepage) ?? '',
    tags: Array.isArray(metadata.tags) ? metadata.tags : [],
    declaredTools: Array.isArray(metadata.declaredTools) ? metadata.declaredTools : [],
    sourcePath,
    sourceRepo: '',
    sourceRef: '',
    sourceSha: '',
    contentHash: contentHashFor(rawBody),
    byteLength: Buffer.byteLength(rawBody, 'utf8'),
    lineCount: rawBody.split(/\r?\n/).length,
    rawBody,
    status: 'pending',
    threatFlags: [],
  };
}

function learnRunResult(record, description, rawBody) {
  return {
    skillId: record.skillId,
    pendingPath: pendingPathFor(record.skillId),
    gist: firstLine(description),
    diffPreview: diffPreviewFor(rawBody),
  };
}

function pendingPathFor(skillId) {
  return `${STAGED_SKILLS_DIR}/skills/${skillId}.json`;
}

function checkRequiredSectionOrder(rawBody) {
  let previous = -1;
  for (const section of REQUIRED_SECTIONS) {
    const index = sectionHeadingIndex(rawBody, section);
    if (index === -1) {
      return {
        ok: false,
        reason: section === 'VERIFICATION'
          ? 'missing_verification'
          : `missing_section_${slugReason(section)}`,
      };
    }
    if (index <= previous) {
      return {
        ok: false,
        reason: 'section_order_invalid',
        detail: { section },
      };
    }
    previous = index;
  }
  return { ok: true };
}

function sectionHeadingIndex(rawBody, section) {
  const pattern = new RegExp(`^#{1,6}\\s+${escapeRegExp(section)}\\s*$`, 'm');
  const match = pattern.exec(rawBody);
  return match ? match.index : -1;
}

function hasProvenanceBlock(rawBody) {
  const block = sectionBlock(rawBody, PROVENANCE_HEADING);
  if (!block) return false;
  return /(https?:\/\/|conversation|ref|path|source|\.md\b|[\w.-]+\/[\w./-]+)/i.test(block);
}

function sectionBlock(rawBody, section) {
  const pattern = new RegExp(`^#{1,6}\\s+${escapeRegExp(section)}\\s*$`, 'm');
  const match = pattern.exec(rawBody);
  if (!match) return '';
  const start = match.index + match[0].length;
  const rest = rawBody.slice(start);
  const next = /\n#{1,6}\s+\S/.exec(rest);
  return (next ? rest.slice(0, next.index) : rest).trim();
}

function usesNonKToolVocabulary(rawBody) {
  return /\b(?:cat|curl)\b/i.test(rawBody);
}

function normalizeSources(sources) {
  const list = Array.isArray(sources) ? sources : [];
  return list.map((source, index) => normalizeSource(source, index)).filter((source) => source.text);
}

function normalizeSource(source, index) {
  if (typeof source === 'string') {
    return { label: `source-${index + 1}`, text: source };
  }
  if (!isPlainObject(source)) {
    return { label: `source-${index + 1}`, text: '' };
  }

  const label =
    optionalString(source.path) ??
    optionalString(source.url) ??
    optionalString(source.ref) ??
    optionalString(source.label) ??
    `source-${index + 1}`;
  const text =
    optionalString(source.text) ??
    optionalString(source.body) ??
    optionalString(source.content) ??
    '';
  return { label, text };
}

function draftRawBody(value) {
  if (typeof value === 'string') return value;
  if (isPlainObject(value)) {
    return requiredRawString(value.rawBody ?? value.body ?? value.content, 'draft rawBody');
  }
  return requiredRawString(value, 'draft rawBody');
}

function normalizeDescription(value) {
  return (optionalString(value) ?? '').replace(/\s+/g, ' ').trim();
}

function firstLine(value) {
  return requiredString(value, 'description').split(/\r?\n/)[0].trim();
}

function sourcePathForName(name) {
  const slug = requiredString(name, 'skill name')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `learn/${slug || 'skill'}/SKILL.md`;
}

function invalid(reason, detail) {
  return Object.freeze({ ok: false, reason, ...(detail ? { detail } : {}) });
}

function rawString(value) {
  return typeof value === 'string' ? value : undefined;
}

function requiredRawString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} is required`);
  }
  return value;
}

function slugReason(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sha256(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}
