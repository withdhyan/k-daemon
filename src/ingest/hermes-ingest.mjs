import {
  fetchHermesUpdates,
} from './hermes.mjs';
import {
  createStagedSkillsStore,
} from './hermes-staging.mjs';

// ── U7 · ingest-hermes orchestration ────────────────────────────────────────
// fetch (read-only) → VET (tool-threat gate) → STAGE (daemon-owns-writes).
// Nothing runs; [auto] is empty; every skill lands as `pending` until the
// founder approves. This is the only place fetch and the staged store meet.

export async function ingestHermes(options = {}) {
  const store = options.store ?? createStagedSkillsStore(options.storeOptions);
  const updates = await fetchHermesUpdates({
    env: options.env,
    config: options.config,
    fetchImpl: options.fetchImpl,
  });

  const staged = [];
  let createdCount = 0;
  let duplicateCount = 0;
  let supersededCount = 0;
  const flagged = [];

  for (const skill of updates.skills) {
    const vet = vetStagedSkill(skill);
    const { record, outcome } = await store.stageSkill({ ...skill, ...vet.annotations });
    staged.push({ record, outcome, threats: vet.threats });
    if (vet.threats.length > 0) flagged.push({ skillId: record.skillId, threats: vet.threats });
    if (outcome === 'created') createdCount += 1;
    else if (outcome === 'duplicate') duplicateCount += 1;
    else if (outcome === 'superseded') supersededCount += 1;
  }

  const notes = [];
  let noteCreatedCount = 0;
  for (const note of updates.capabilityNotes) {
    const { record, outcome } = await store.stageNote(note);
    notes.push({ record, outcome });
    if (outcome === 'created' || outcome === 'updated') noteCreatedCount += 1;
  }

  return {
    store,
    repo: updates.repo,
    ref: updates.ref,
    surface: updates.surface,
    staged,
    notes,
    quarantined: updates.quarantined,
    flagged,
    createdCount,
    duplicateCount,
    supersededCount,
    noteCreatedCount,
    quarantinedCount: updates.quarantined.length,
    scannedCount: updates.scannedCount,
  };
}

// Tool-threat gate (SEC-006): declaratively scan the front-matter's declared
// tools + body for capability requests that MUST have founder eyes before
// approval (network egress, shell/exec, filesystem writes, secret access).
// This never blocks staging — it ANNOTATES the record so the approval surface
// can foreground the risk. Nothing is auto-approved either way ([auto] empty).
const THREAT_TOOL_PATTERNS = Object.freeze([
  { threat: 'shell-exec', re: /\b(bash|shell|exec|subprocess|child_process|system|eval)\b/i },
  { threat: 'network-egress', re: /\b(fetch|http|https|curl|wget|request|socket|net)\b/i },
  { threat: 'filesystem-write', re: /\b(fs\.write|writeFile|unlink|rmdir|mkdir|chmod|delete_file)\b/i },
  { threat: 'secret-access', re: /\b(api[_-]?key|secret|token|credential|password|env)\b/i },
]);

export function vetStagedSkill(skill) {
  const haystackTools = (skill.declaredTools ?? []).join(' ');
  const haystackBody = String(skill.rawBody ?? '');
  const threats = [];

  for (const { threat, re } of THREAT_TOOL_PATTERNS) {
    if (re.test(haystackTools) || re.test(haystackBody)) {
      threats.push(threat);
    }
  }

  return {
    threats,
    annotations: {
      threatFlags: threats,
      requiresReview: true, // ALWAYS — foreign code never auto-activates
    },
  };
}
