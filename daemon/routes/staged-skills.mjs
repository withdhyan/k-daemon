import {
  createStagedSkillsStore,
} from '../../src/ingest/hermes-staging.mjs';
import {
  isPlainObject,
  optionalString,
} from '../../src/substrate.mjs';

// ── U7 · daemon staged-skills review surface ────────────────────────────────
// Inbound-only HTTP over the loopback/Tailscale façade. Lists pending staged
// skills, exposes the FULL raw SKILL.md body for inspection (SEC-006 — never a
// summary), and lets the founder approve/reject. Approve MARKS the record only;
// nothing foreign executes here. daemon-owns-writes (all mutations go through
// the StagedSkillsStore, filenames are content-derived ids).
//
// Registration in daemon/server.mjs is a small delegation to
// handleStagedSkillsRoute — keep route bodies here to minimize merge conflicts.

export const STAGED_SKILLS_LIST_PATH = '/api/skills/staged';
export const STAGED_SKILLS_DECISION_PATH = '/api/skills/staged/decision';
export const STAGED_SKILLS_NOTES_PATH = '/api/skills/staged/notes';

export function isStagedSkillsPath(pathname) {
  return (
    pathname === STAGED_SKILLS_LIST_PATH ||
    pathname === STAGED_SKILLS_DECISION_PATH ||
    pathname === STAGED_SKILLS_NOTES_PATH ||
    pathname.startsWith(`${STAGED_SKILLS_LIST_PATH}/`)
  );
}

// Returns true if it handled the request. deps supplies { sendJson, httpError,
// readPlaintextJson } so this module reuses the server's canonical helpers
// (never re-copies them).
export async function handleStagedSkillsRoute(request, response, context, deps) {
  const { method, pathname } = context;
  const { sendJson, httpError, readPlaintextJson } = deps;
  const store = context.stagedSkillsStore ??
    createStagedSkillsStore({ dataDir: context.dataDir, now: context.now });

  if (method === 'GET' && pathname === STAGED_SKILLS_LIST_PATH) {
    sendJson(response, 200, await listStagedSkills(store));
    return true;
  }

  if (method === 'GET' && pathname.startsWith(`${STAGED_SKILLS_LIST_PATH}/`)) {
    const skillId = pathname.slice(`${STAGED_SKILLS_LIST_PATH}/`.length);
    const record = await store.readSkill(skillId).catch(() => null);
    if (!record) throw httpError(404, 'staged_skill_not_found');
    // Full raw body exposed here for inspection (SEC-006).
    sendJson(response, 200, projectSkillDetail(record));
    return true;
  }

  if (method === 'GET' && pathname === STAGED_SKILLS_NOTES_PATH) {
    const notes = await store.listNotes();
    sendJson(response, 200, { notes: notes.map(projectNote) });
    return true;
  }

  if (method === 'POST' && pathname === STAGED_SKILLS_DECISION_PATH) {
    const payload = await readPlaintextJson(request);
    sendJson(response, 200, await decideStagedSkill(store, payload, httpError));
    return true;
  }

  if (isStagedSkillsPath(pathname)) {
    sendJson(response, 405, { ok: false, error: 'method_not_allowed' });
    return true;
  }

  return false;
}

async function listStagedSkills(store) {
  const skills = await store.listSkills();
  const live = skills.filter((record) => !record.validTo && !record.supersededById);
  return {
    skills: live.map(projectSkillSummary),
    pendingCount: live.filter((record) => record.status === 'pending').length,
  };
}

async function decideStagedSkill(store, payload, httpError) {
  if (!isPlainObject(payload)) throw httpError(400, 'invalid_decision_payload');
  rejectClientPathFields(payload, httpError);

  const skillId = optionalString(payload.skillId);
  if (!skillId) throw httpError(400, 'missing_skillId');

  const decision = optionalString(payload.decision);
  if (decision !== 'approve' && decision !== 'reject') {
    throw httpError(400, 'invalid_decision');
  }
  const status = decision === 'approve' ? 'approved' : 'rejected';

  let result;
  try {
    result = await store.setSkillStatus(skillId, status, { note: payload.note });
  } catch {
    throw httpError(400, 'invalid_skillId');
  }
  if (!result) throw httpError(404, 'staged_skill_not_found');

  return {
    ok: true,
    skillId,
    status: result.record.status,
    // Approval MARKS the record; activation into the owned loader is a separate
    // daemon step. Nothing foreign ran.
    activated: false,
  };
}

function projectSkillSummary(record) {
  return {
    skillId: record.skillId,
    name: record.name,
    description: record.description,
    version: record.version,
    status: record.status,
    threatFlags: Array.isArray(record.threatFlags) ? record.threatFlags : [],
    requiresReview: record.requiresReview !== false,
    sourceRepo: record.sourceRepo,
    sourcePath: record.sourcePath,
    byteLength: record.byteLength,
    lineCount: record.lineCount,
  };
}

function projectSkillDetail(record) {
  return {
    ...projectSkillSummary(record),
    license: record.license,
    author: record.author,
    homepage: record.homepage,
    tags: Array.isArray(record.tags) ? record.tags : [],
    declaredTools: Array.isArray(record.declaredTools) ? record.declaredTools : [],
    sourceRef: record.sourceRef,
    sourceSha: record.sourceSha,
    contentHash: record.contentHash,
    // The FULL raw SKILL.md body, verbatim, for inspection (SEC-006).
    rawBody: record.rawBody,
  };
}

function projectNote(record) {
  return {
    noteId: record.noteId,
    tag: record.tag,
    name: record.name,
    publishedAt: record.publishedAt,
    url: record.url,
    body: record.body,
    status: record.status,
  };
}

function rejectClientPathFields(payload, httpError) {
  for (const field of ['path', 'file', 'relPath', 'targetPath', 'skillPath']) {
    if (Object.hasOwn(payload, field)) {
      throw httpError(400, 'client_path_not_allowed');
    }
  }
}
