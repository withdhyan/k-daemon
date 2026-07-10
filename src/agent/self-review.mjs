import path from 'node:path';

import { createStagedSkillsStore } from '../ingest/hermes-staging.mjs';
import { isPlainObject, optionalString, requiredString } from '../substrate.mjs';
import { diffPreviewFor, runLearn } from './learn.mjs';
import { readNoteEntries } from './notes.mjs';
import { stagePendingNoteProposal } from './notes-pending.mjs';
import { MIN_CONFIDENCE, MIN_RELEVANCE, shouldSurface } from './suppressor.mjs';

export const SELF_REVIEW_QUESTION =
  'should any skill or note be saved/updated from this conversation?';
export const SELF_REVIEW_SNAPSHOT_MAX_CHARS = 8 * 1024;
const DEFAULT_SELF_REVIEW_CONFIDENCE = 0.9;

const SELF_REVIEW_TOOL = Object.freeze({
  name: 'self_review_proposals',
  description: 'Return staged note or staged skill proposals from one contained self-review question.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      proposals: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: true,
          properties: {
            kind: { type: 'string', enum: ['note', 'skill'] },
            action: { type: 'string' },
            target: { type: 'string' },
            targetPath: { type: 'string' },
            gist: { type: 'string' },
            evidence: {
              oneOf: [
                { type: 'string' },
                { type: 'array', items: { type: 'string' } },
              ],
            },
            text: { type: 'string' },
            existingText: { type: 'string' },
            replacement: { type: 'string' },
            rawBody: { type: 'string' },
            beforeAfterMeasure: { type: 'string' },
            relevance: { type: 'number', minimum: 0, maximum: 1 },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
          },
          required: ['kind', 'action', 'evidence'],
        },
      },
    },
    required: ['proposals'],
  },
});

const GOVERNANCE_TARGET_PATTERNS = Object.freeze([
  /(^|\/)src\/next-action\.mjs$/i,
  /(^|\/)next-action\.mjs$/i,
  /(^|\/)life-constitution\.md$/i,
  /\bconstitution\b/i,
  /\bsafedatapath\b/i,
  /\bauto_allowlist\b/i,
  /\brefuseautoaction\b/i,
]);

const GATED_PATH_PATTERNS = Object.freeze([
  /^src(?:\/|$)/i,
  /^stations(?:\/|$)/i,
  /^daemon(?:\/|$)/i,
]);

export async function runSelfReview({
  conversationSnapshot,
  singleCall,
  dataDir,
  now,
  attention = 'open',
  lastSurfacedAt,
  surfacedCountThisHour = 0,
  logger = console,
} = {}) {
  const snapshot = boundSnapshot(requiredString(conversationSnapshot, 'conversationSnapshot'));
  if (typeof singleCall !== 'function') throw new Error('self-review singleCall is required');

  const request = buildSelfReviewRequest({ conversationSnapshot: snapshot, now });
  const rawOutput = await singleCall(request);
  const proposals = parseSelfReviewOutput(rawOutput);
  const staged = [];
  const surfaceCandidates = [];
  const rejected = [];

  for (const proposal of proposals) {
    const result = await processProposal(proposal, { conversationSnapshot: snapshot, dataDir, now });
    if (result.ok) {
      staged.push(result.record);
      surfaceCandidates.push(surfaceCandidateFor(proposal, snapshot));
    } else {
      rejected.push(result.rejection);
    }
  }

  if (rejected.length > 0) {
    logger?.warn?.(`[cs-k] self-review: rejected ${rejected.length} proposal(s)`);
  }

  const notification = buildSelfReviewNotification({
    staged,
    surfaceCandidates,
    attention,
    lastSurfacedAt,
    surfacedCountThisHour,
    now: currentInstant(now),
  });

  if (notification?.surface && notification.text) {
    logger?.info?.(notification.text);
  }

  return Object.freeze({
    ok: true,
    question: SELF_REVIEW_QUESTION,
    parsedCount: proposals.length,
    staged: Object.freeze(staged),
    rejected: Object.freeze(rejected),
    notification,
    suppressed: notification?.suppressed === true,
    reason: notification?.reason,
  });
}

export function buildSelfReviewRequest({ conversationSnapshot, now } = {}) {
  const snapshot = boundSnapshot(requiredString(conversationSnapshot, 'conversationSnapshot'));
  const today = typeof now === 'function' ? now().toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
  return Object.freeze({
    label: 'cs-k:self-review',
    model: 'sovereign',
    maxTokens: 2048,
    system: [
      'You are K running a contained background self-review fork.',
      'Return only self_review_proposals. Do not write files, call tools, or propose active code edits.',
      'Allowed targets are operational notes and staged SKILL.md candidates.',
      'Every proposal must quote concrete evidence from the conversation snapshot.',
      `Score each proposal with relevance and confidence from 0 to 1; surfacing requires relevance >= ${MIN_RELEVANCE} and confidence >= ${MIN_CONFIDENCE}.`,
    ].join('\n'),
    user: [
      `Today is ${today}.`,
      `Question: ${SELF_REVIEW_QUESTION}`,
      '',
      '<conversation_snapshot>',
      snapshot,
      '</conversation_snapshot>',
    ].join('\n'),
    tool: SELF_REVIEW_TOOL,
  });
}

export function parseSelfReviewOutput(rawOutput) {
  const parsed = parseMaybeJson(rawOutput);
  if (Array.isArray(parsed)) return parsed.filter(isPlainObject);
  if (!isPlainObject(parsed)) return [];
  if (Array.isArray(parsed.proposals)) return parsed.proposals.filter(isPlainObject);
  if (isPlainObject(parsed.proposal)) return [parsed.proposal];
  return [];
}

async function processProposal(proposal, context) {
  const targetKind = normalizeProposalKind(proposal);
  if (!targetKind) return reject(proposal, 'gated_target');

  const targetGate = classifyTargetGate(proposal, targetKind);
  if (targetGate) return reject(proposal, targetGate);

  const evidence = concreteEvidence(proposal, context.conversationSnapshot);
  if (evidence.length === 0) return reject(proposal, 'evidence_required');

  if (targetKind === 'note') {
    return processNoteProposal(proposal, evidence, context);
  }
  return processSkillProposal(proposal, evidence, context);
}

async function processNoteProposal(proposal, evidence, context) {
  const action = normalizeNoteAction(proposal.action ?? proposal.operation);
  if (!action) return reject(proposal, 'unsupported_note_action');

  const payload = notePayload(proposal, action);
  if (!payload) return reject(proposal, 'invalid_note_payload');

  if (action === 'replace' || action === 'remove') {
    const existingText = optionalString(payload.existingText);
    if (!existingText) return reject(proposal, 'read_before_write_violation');
    const existingEntries = await readNoteEntries({ dataDir: context.dataDir });
    if (!existingEntries.some((entry) => entry === existingText)) {
      return reject(proposal, 'read_before_write_violation');
    }
  }

  const staged = await stagePendingNoteProposal({
    origin: 'self_review',
    payload,
    gist: optionalString(proposal.gist) ?? gistForNotePayload(payload),
    diffPreview: diffPreviewForNotePayload(payload),
    evidence,
  }, {
    dataDir: context.dataDir,
    now: context.now,
  });

  return {
    ok: true,
    record: Object.freeze({
      kind: 'PendingNoteProposal',
      origin: 'self_review',
      proposalId: staged.record.proposalId,
      pendingPath: staged.pendingPath,
      gist: staged.record.gist,
      diffPreview: staged.record.diffPreview,
    }),
  };
}

async function processSkillProposal(proposal, evidence, context) {
  const rawBody = optionalString(proposal.rawBody ?? proposal.body ?? proposal.content);
  if (!rawBody) return reject(proposal, 'missing_skill_body');

  let stagedRecord;
  const store = createStagedSkillsStore({ dataDir: context.dataDir, now: context.now });
  const beforeAfterMeasure =
    optionalString(proposal.beforeAfterMeasure) ??
    'pending founder review; no active skill behavior changes until approval';

  const learned = await runLearn({
    request: learnRequestForProposal(proposal, evidence),
    gather: async () => [{ label: 'conversation-evidence', text: evidence.join('\n\n') }],
    draft: async () => rawBody,
    dataDir: context.dataDir,
    now: context.now,
    stage: async (input) => {
      const staged = await store.stageSkill({
        ...input,
        kind: 'StagedSkillProposal',
        origin: 'self_review',
        proposalEvidence: evidence,
        gist: optionalString(proposal.gist) ?? firstLine(input.description),
        diffPreview: diffPreviewFor(rawBody),
        beforeAfterMeasure,
        governanceTag: '[gate:human]',
      });
      stagedRecord = staged.record;
      return staged;
    },
  });

  if (learned?.ok === false) return reject(proposal, learned.reason ?? 'invalid_skill_proposal');
  if (!stagedRecord) return reject(proposal, 'invalid_skill_proposal');

  return {
    ok: true,
    record: Object.freeze({
      kind: 'StagedSkillProposal',
      origin: 'self_review',
      skillId: stagedRecord.skillId,
      pendingPath: learned.pendingPath,
      gist: learned.gist,
      diffPreview: learned.diffPreview,
    }),
  };
}

function normalizeProposalKind(proposal) {
  const kind = optionalString(proposal.kind ?? proposal.type ?? proposal.targetType ?? proposal.target);
  if (!kind) return null;
  const normalized = kind.toLowerCase().replace(/[\s_-]+/g, '');
  if (normalized === 'note' || normalized === 'notes' || normalized === 'operationalnote') return 'note';
  if (normalized === 'skill' || normalized === 'skills' || normalized === 'stagedskill' || normalized === 'stagedskillproposal') {
    return 'skill';
  }
  return null;
}

function classifyTargetGate(proposal, targetKind) {
  const descriptors = targetDescriptors(proposal);
  for (const descriptor of descriptors) {
    if (GOVERNANCE_TARGET_PATTERNS.some((pattern) => pattern.test(descriptor))) {
      return 'immutable_governance_core';
    }
  }
  for (const descriptor of descriptors) {
    const rel = normalizedRelPath(descriptor);
    if (rel && GATED_PATH_PATTERNS.some((pattern) => pattern.test(rel))) {
      return 'gated_target';
    }
  }

  for (const descriptor of descriptors) {
    if (isAllowedTargetDescriptor(descriptor, targetKind)) continue;
    return 'gated_target';
  }

  return null;
}

function targetDescriptors(proposal) {
  const direct = [
    proposal.targetPath,
    proposal.path,
    proposal.file,
    proposal.relPath,
    proposal.skillPath,
    proposal.notePath,
    proposal.sourcePath,
    proposal.target,
  ];
  const arrays = [
    proposal.targetPaths,
    proposal.paths,
    proposal.files,
    proposal.targets,
  ].flatMap((value) => Array.isArray(value) ? value : []);

  return [...direct, ...arrays]
    .map((value) => optionalString(value))
    .filter(Boolean);
}

function isAllowedTargetDescriptor(descriptor, targetKind) {
  const lowered = descriptor.toLowerCase();
  const rel = normalizedRelPath(descriptor);
  if (targetKind === 'note') {
    return (
      lowered === 'note' ||
      lowered === 'notes' ||
      lowered.includes('operational note') ||
      rel === 'data/notes/notes.md' ||
      rel === 'notes/notes.md' ||
      rel.startsWith('data/pending/notes/') ||
      rel.startsWith('pending/notes/')
    );
  }

  return (
    lowered === 'skill' ||
    lowered === 'skills' ||
    lowered === 'staged skill' ||
    lowered === 'staged skills' ||
    rel.startsWith('data/staged-skills/') ||
    rel.startsWith('staged-skills/') ||
    rel.startsWith('learn/')
  );
}

function normalizedRelPath(value) {
  const text = optionalString(value);
  if (!text) return '';
  return path.normalize(text).replaceAll('\\', '/').replace(/^\/+/, '').toLowerCase();
}

function concreteEvidence(proposal, conversationSnapshot) {
  const normalizedSnapshot = normalizeEvidenceText(conversationSnapshot);
  return evidenceList(proposal.evidence)
    .filter((evidence) => evidence.length >= 8)
    .filter((evidence) => normalizedSnapshot.includes(normalizeEvidenceText(evidence)));
}

function surfaceCandidateFor(proposal, conversationSnapshot) {
  const evidence = concreteEvidence(proposal, conversationSnapshot);
  return Object.freeze({
    relevance: scoreValue(proposal.relevance ?? proposal.relevanceScore ?? proposal.score?.relevance, relevanceFromEvidence(evidence)),
    confidence: scoreValue(
      proposal.confidence ?? proposal.modelConfidence ?? proposal.statedConfidence ?? proposal.score?.confidence,
      DEFAULT_SELF_REVIEW_CONFIDENCE,
    ),
  });
}

function relevanceFromEvidence(evidence) {
  const evidenceChars = evidence.reduce((sum, item) => sum + item.length, 0);
  if (evidenceChars === 0) return 0;
  const lengthSignal = Math.min(MIN_RELEVANCE, evidenceChars / 200);
  const countSignal = Math.min(1 - MIN_RELEVANCE, evidence.length * 0.15);
  return clampScore(lengthSignal + countSignal);
}

function scoreValue(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) return clampScore(normalizeScoreScale(value));
  const text = optionalString(value);
  if (!text) return fallback;
  const parsed = Number(text.endsWith('%') ? text.slice(0, -1) : text);
  return Number.isFinite(parsed) ? clampScore(normalizeScoreScale(parsed)) : fallback;
}

function normalizeScoreScale(value) {
  return value > 1 && value <= 100 ? value / 100 : value;
}

function clampScore(value) {
  return Math.min(1, Math.max(0, value));
}

function buildSelfReviewNotification({
  staged,
  surfaceCandidates,
  attention,
  lastSurfacedAt,
  surfacedCountThisHour,
  now,
}) {
  if (staged.length === 0) return null;

  const decisions = surfaceCandidates.map((candidate) => Object.freeze({
    ...candidate,
    ...shouldSurface({
      relevance: candidate.relevance,
      confidence: candidate.confidence,
      attention,
      lastSurfacedAt,
      surfacedCountThisHour,
      now,
    }),
  }));
  const surfaced = decisions.find((decision) => decision.surface);
  if (surfaced) {
    return Object.freeze({
      surface: true,
      suppressed: false,
      reason: surfaced.reason,
      relevance: surfaced.relevance,
      confidence: surfaced.confidence,
      text: selfReviewNotificationText(staged),
    });
  }

  const suppressed = strongestDecision(decisions) ?? Object.freeze({
    reason: 'no_surface_candidate',
    relevance: 0,
    confidence: DEFAULT_SELF_REVIEW_CONFIDENCE,
  });
  return Object.freeze({
    surface: false,
    suppressed: true,
    reason: suppressed.reason,
    relevance: suppressed.relevance,
    confidence: suppressed.confidence,
  });
}

function strongestDecision(decisions) {
  return [...decisions].sort((a, b) =>
    (b.relevance + b.confidence) - (a.relevance + a.confidence) ||
    b.relevance - a.relevance ||
    b.confidence - a.confidence)[0];
}

function selfReviewNotificationText(staged) {
  const count = staged.length;
  const plural = count === 1 ? '' : 's';
  return `💾 self-improvement review: staged ${count} proposal${plural} for founder review.`;
}

function evidenceList(value) {
  if (Array.isArray(value)) {
    return value.map((item) =>
      optionalString(item?.excerpt ?? item?.quote ?? item?.text ?? item)).filter(Boolean);
  }
  const text = optionalString(value?.excerpt ?? value?.quote ?? value?.text ?? value);
  return text ? [text] : [];
}

function normalizeEvidenceText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function normalizeNoteAction(value) {
  const action = optionalString(value);
  if (action === 'add' || action === 'create') return 'add';
  if (action === 'replace' || action === 'update' || action === 'edit') return 'replace';
  if (action === 'remove' || action === 'delete') return 'remove';
  return null;
}

function notePayload(proposal, action) {
  if (action === 'add') {
    const text = optionalString(proposal.text ?? proposal.note ?? proposal.body ?? proposal.content);
    return text ? Object.freeze({ action, text }) : null;
  }
  if (action === 'replace') {
    const existingText = optionalString(proposal.existingText ?? proposal.currentText ?? proposal.match ?? proposal.oldText);
    const replacement = optionalString(proposal.replacement ?? proposal.newText ?? proposal.text ?? proposal.note);
    return existingText && replacement
      ? Object.freeze({ action, existingText, replacement })
      : null;
  }
  const existingText = optionalString(proposal.existingText ?? proposal.currentText ?? proposal.match ?? proposal.text ?? proposal.note);
  return existingText ? Object.freeze({ action, existingText }) : null;
}

function gistForNotePayload(payload) {
  if (payload.action === 'add') return firstLine(payload.text);
  if (payload.action === 'replace') return `Replace note: ${firstLine(payload.existingText)}`;
  return `Remove note: ${firstLine(payload.existingText)}`;
}

function diffPreviewForNotePayload(payload) {
  if (payload.action === 'add') return `+${payload.text}`;
  if (payload.action === 'replace') return `-${payload.existingText}\n+${payload.replacement}`;
  return `-${payload.existingText}`;
}

function learnRequestForProposal(proposal, evidence) {
  const gist = optionalString(proposal.gist) ?? 'Stage a K-authored skill proposal from self-review.';
  return [
    gist,
    '',
    'Origin: self_review',
    'Evidence:',
    ...evidence.map((item) => `- ${item}`),
  ].join('\n');
}

function reject(proposal, reason) {
  return {
    ok: false,
    rejection: Object.freeze({
      reason,
      kind: optionalString(proposal?.kind ?? proposal?.type ?? proposal?.targetType ?? proposal?.target) ?? 'unknown',
      targetPath: optionalString(proposal?.targetPath ?? proposal?.path ?? proposal?.file),
      gist: optionalString(proposal?.gist),
    }),
  };
}

function parseMaybeJson(value) {
  if (isPlainObject(value) || Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    return JSON.parse(value);
  } catch {
    const objectMatch = /\{[\s\S]*\}/.exec(value);
    if (!objectMatch) return {};
    try {
      return JSON.parse(objectMatch[0]);
    } catch {
      return {};
    }
  }
}

function boundSnapshot(value) {
  const text = requiredString(value, 'conversationSnapshot');
  return text.length > SELF_REVIEW_SNAPSHOT_MAX_CHARS
    ? text.slice(-SELF_REVIEW_SNAPSHOT_MAX_CHARS)
    : text;
}

function currentInstant(now) {
  if (typeof now === 'function') return now();
  if (now instanceof Date || typeof now === 'number' || typeof now === 'string') return now;
  return new Date();
}

function firstLine(value) {
  return requiredString(value, 'text').split(/\r?\n/)[0].slice(0, 160);
}
