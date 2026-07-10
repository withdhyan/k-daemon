import { promises as fs } from 'node:fs';
import path from 'node:path';

import { iso, safeDataPath } from '../../daemon/run.mjs';
import { evidenceGrade as pipelineEvidenceGrade } from '../research/pipeline.mjs';

const FILLER_WORDS = String.raw`(?:\w+\s+){0,8}`;
const GLAZE_MATCH_WINDOW = 96;

export const GLAZE_SURFACE_THRESHOLD = 0.5;

export const EVIDENCE_LEVEL_TO_GRADE = Object.freeze({
  ANECDOTE: pipelineEvidenceGrade(0),
  SPECULATIVE: pipelineEvidenceGrade(0),
  UNKNOWN: pipelineEvidenceGrade(0),
  WEAK: pipelineEvidenceGrade(0.35),
  MODERATE: pipelineEvidenceGrade(0.6),
  STRONG: pipelineEvidenceGrade(0.8),
});

export const GLAZE_PATTERNS = Object.freeze([
  {
    pattern: 'direct praise',
    regex: new RegExp(String.raw`\bgreat\s+${FILLER_WORDS}(?:job|work|question|point|insight)\b`, 'iu'),
    weight: 0.35,
  },
  {
    pattern: 'superlative praise',
    regex: /\b(?:excellent|amazing|wonderful|fantastic|brilliant|impressive)\b/iu,
    // Heaviest marker: 0.4 so superlative + any second signal (e.g. an
    // exclamation) crosses the 0.5 surface threshold; alone it stays below.
    weight: 0.4,
  },
  {
    pattern: 'unnecessary affirmation',
    regex: new RegExp(String.raw`\byou(?:'re| are)\s+${FILLER_WORDS}(?:right|correct)\b`, 'iu'),
    weight: 0.35,
  },
  {
    pattern: 'validating preamble',
    regex: new RegExp(
      String.raw`\bthat(?:'s| is)\s+${FILLER_WORDS}(?:a|an)\s+${FILLER_WORDS}(?:great|excellent|wonderful|good)\s+${FILLER_WORDS}(?:point|question|observation)\b`,
      'iu',
    ),
    weight: 0.35,
  },
  {
    pattern: 'personalising to validate',
    regex: /\bi (?:think|believe|feel)\s+(?:that\s+)?you\b/iu,
    weight: 0.25,
  },
  {
    pattern: 'normalising without evidence',
    regex: /\bit(?:'s| is)\s+(?:totally|completely|absolutely|perfectly)\s+(?:understandable|normal|natural)\b/iu,
    weight: 0.25,
  },
  {
    pattern: 'exclamation mark',
    regex: /!/u,
    weight: 0.15,
  },
  {
    pattern: 'emoji',
    regex: /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}]/u,
    weight: 0.35,
  },
  {
    pattern: 'unexpected capitalisation',
    regex: /^[A-Z]{2,}/mu,
    weight: 0.2,
  },
  {
    pattern: 'excessive hedging',
    regex: /\b(?:maybe|perhaps|possibly|might|could)\b/iu,
    weight: 0.15,
  },
]);

export function detectGlaze(text) {
  const value = String(text ?? '');
  const hits = [];
  let score = 0;

  for (const entry of GLAZE_PATTERNS) {
    const match = entry.regex.exec(value);
    if (!match) continue;

    hits.push(Object.freeze({
      pattern: entry.pattern,
      excerpt: excerptForMatch(value, match),
    }));
    score += entry.weight;
  }

  return Object.freeze({
    score: Math.min(1, Number(score.toFixed(2))),
    hits: Object.freeze(hits),
  });
}

export function gradeEvidence(items = []) {
  const list = Array.isArray(items) ? items : [items];
  if (list.length === 0) return EVIDENCE_LEVEL_TO_GRADE.ANECDOTE;

  let bestRank = 0;
  let observationCount = 0;

  for (const item of list) {
    if (!item || typeof item !== 'object') {
      observationCount += 1;
      continue;
    }

    const explicitGrade = canonicalGrade(item.evidenceGrade ?? item.grade);
    if (explicitGrade) {
      bestRank = Math.max(bestRank, gradeRank(explicitGrade));
      continue;
    }

    const explicitLevel = evidenceLevel(item.level ?? item.evidenceLevel ?? item.strength ?? item.grade);
    if (explicitLevel) {
      bestRank = Math.max(bestRank, gradeRank(EVIDENCE_LEVEL_TO_GRADE[explicitLevel]));
      continue;
    }

    if (item.replicated === true && item.mechanistic === true) {
      bestRank = Math.max(bestRank, gradeRank(EVIDENCE_LEVEL_TO_GRADE.STRONG));
      continue;
    }
    if (item.replicated === true || item.mechanistic === true) {
      bestRank = Math.max(bestRank, gradeRank(EVIDENCE_LEVEL_TO_GRADE.MODERATE));
      continue;
    }

    const n = numericObservationCount(item);
    if (n > 0) observationCount += n;
    else observationCount += 1;
  }

  if (observationCount >= 3) {
    bestRank = Math.max(bestRank, gradeRank(EVIDENCE_LEVEL_TO_GRADE.WEAK));
  } else if (observationCount > 0) {
    bestRank = Math.max(bestRank, gradeRank(EVIDENCE_LEVEL_TO_GRADE.ANECDOTE));
  }

  return rankGrade(bestRank);
}

export function createContradictionRegister({ dataDir, now = () => new Date() } = {}) {
  if (!dataDir) throw new Error('dataDir is required');

  const dir = safeDataPath(dataDir, 'truth');
  const file = safeDataPath(dataDir, path.join('truth', 'contradictions.jsonl'));

  return Object.freeze({
    dir,
    file,
    async record(change) {
      const record = contradictionRecord(change, now);
      await fs.mkdir(dir, { recursive: true });
      await fs.appendFile(file, `${JSON.stringify(record)}\n`, 'utf8');
      return Object.freeze(record);
    },
    async list({ claimId } = {}) {
      let text;
      try {
        text = await fs.readFile(file, 'utf8');
      } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
      }

      const records = text
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      if (claimId === undefined) return records;
      return records.filter((record) => record.claimId === String(claimId));
    },
  });
}

function contradictionRecord(change, now) {
  if (!change || typeof change !== 'object') {
    throw new Error('contradiction change must be an object');
  }

  return {
    claimId: requiredString(change.claimId, 'claimId'),
    previous: requiredString(change.previous, 'previous'),
    current: requiredString(change.current, 'current'),
    changedAt: iso(change.changedAt ?? now),
    reason: requiredString(change.reason, 'reason'),
  };
}

function excerptForMatch(text, match) {
  const start = Math.max(0, match.index - Math.floor(GLAZE_MATCH_WINDOW / 3));
  const end = Math.min(text.length, match.index + match[0].length + Math.floor(GLAZE_MATCH_WINDOW / 3));
  return text.slice(start, end).replace(/\s+/gu, ' ').trim();
}

function canonicalGrade(value) {
  const normalized = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return /^L[1-4]$/.test(normalized) ? normalized : undefined;
}

function evidenceLevel(value) {
  const normalized = typeof value === 'string'
    ? value.trim().toUpperCase().replace(/[-\s]+/gu, '_')
    : '';
  return EVIDENCE_LEVEL_TO_GRADE[normalized] ? normalized : undefined;
}

function numericObservationCount(item) {
  for (const value of [item.nObservations, item.n_observations, item.observations]) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return 0;
}

function gradeRank(grade) {
  return Number(String(grade).slice(1)) - 1;
}

function rankGrade(rank) {
  return `L${Math.max(1, Math.min(4, rank + 1))}`;
}

function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}
