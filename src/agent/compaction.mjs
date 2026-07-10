import { optionalString } from '../substrate.mjs';

export const DEFAULT_HISTORY_MAX_CHARS = 16_000;
export const DEFAULT_KEEP_TAIL_CHARS = 8_000;
export const SUMMARY_PREFIX = '[earlier conversation summary]';
export const OMITTED_MARKER = '[earlier turns omitted]';

const SUMMARY_MAX_CHARS = 4_000;
const ROLE_LABELS = Object.freeze({
  user: 'founder',
  assistant: 'K',
  system: 'system',
});

/**
 * Compact a long founder chat transcript as:
 * protected first exchange + one synthetic middle summary + verbatim live tail.
 *
 * @param {object} input
 * @param {Array<{role:string,content:string}>} input.history
 * @param {number} input.maxChars
 * @param {number} input.keepTailChars
 * @param {(text:string)=>Promise<string>|string} input.summarize
 * @returns {Promise<{history:Array, compacted:boolean, summaryEntry?:object}>}
 */
export async function compactHistory({
  history,
  maxChars = DEFAULT_HISTORY_MAX_CHARS,
  keepTailChars = DEFAULT_KEEP_TAIL_CHARS,
  summarize,
} = {}) {
  const source = Array.isArray(history) ? history : [];
  if (source.length === 0) return Object.freeze({ history: [], compacted: false });

  const cap = positiveInteger(maxChars, DEFAULT_HISTORY_MAX_CHARS);
  const tailCap = positiveInteger(keepTailChars, Math.floor(cap / 2));
  if (renderEntries(source).length <= cap) {
    return Object.freeze({ history: source, compacted: false });
  }

  const entries = indexedEntries(source);
  if (entries.length === 0) return Object.freeze({ history: [], compacted: false });

  const headIndexes = new Set(selectHeadExchangeIndexes(entries));
  const tailIndexes = new Set(selectTailIndexes(entries, headIndexes, tailCap));
  const head = entries.filter((entry) => headIndexes.has(entry.index)).map(outputEntry);
  const tail = entries.filter((entry) => tailIndexes.has(entry.index)).map(outputEntry);
  const middle = entries.filter((entry) => !headIndexes.has(entry.index) && !tailIndexes.has(entry.index));

  if (middle.length === 0) {
    return Object.freeze({
      history: Object.freeze([...head, ...tail]),
      compacted: true,
    });
  }

  const middleText = renderIndexedEntries(middle);
  const lastUserRequest = lastUserContent(middle);

  try {
    if (typeof summarize !== 'function') throw new Error('history summarize seam is required');
    const rawSummary = await summarize(middleText);
    const summaryEntry = buildSummaryEntry({
      rawSummary,
      lastUserRequest,
      maxChars: summaryContentBudget({ maxChars: cap, head, tail }),
    });
    return Object.freeze({
      history: Object.freeze([...head, summaryEntry, ...tail]),
      compacted: true,
      summaryEntry,
    });
  } catch {
    const markerEntry = Object.freeze({ role: 'system', content: OMITTED_MARKER });
    return Object.freeze({
      history: Object.freeze(fallbackTruncatedHistory({ head, middle, tail, markerEntry, maxChars: cap })),
      compacted: true,
      summaryEntry: markerEntry,
    });
  }
}

function selectHeadExchangeIndexes(entries) {
  const firstUserOffset = entries.findIndex((entry) => entry.role === 'user');
  if (firstUserOffset < 0) return [entries[0].index];

  const indexes = [entries[firstUserOffset].index];
  const assistant = entries.find((entry, offset) =>
    offset > firstUserOffset && entry.role === 'assistant');
  if (assistant) indexes.push(assistant.index);
  return indexes;
}

function selectTailIndexes(entries, headIndexes, keepTailChars) {
  const selected = [];
  let used = 0;

  for (let offset = entries.length - 1; offset >= 0; offset -= 1) {
    const entry = entries[offset];
    if (headIndexes.has(entry.index)) break;

    const lineLength = renderIndexedEntry(entry).length + (selected.length > 0 ? 1 : 0);
    if (selected.length > 0 && used + lineLength > keepTailChars) break;

    selected.push(entry.index);
    used += lineLength;
  }

  return selected.reverse();
}

function fallbackTruncatedHistory({ head, middle, tail, markerEntry, maxChars }) {
  const keptMiddle = [];
  const fixed = [...head, markerEntry, ...tail];
  const remaining = maxChars - renderEntries(fixed).length - 2;
  let used = 0;

  if (remaining > 0) {
    for (let offset = middle.length - 1; offset >= 0; offset -= 1) {
      const entry = outputEntry(middle[offset]);
      const lineLength = renderEntries([entry]).length + (keptMiddle.length > 0 ? 1 : 0);
      if (used + lineLength > remaining) break;
      keptMiddle.unshift(entry);
      used += lineLength;
    }
  }

  return [...head, markerEntry, ...keptMiddle, ...tail];
}

function buildSummaryEntry({ rawSummary, lastUserRequest, maxChars }) {
  const summary = stripDuplicatePrefix(normalizeSummaryText(rawSummary));
  const lines = [SUMMARY_PREFIX];
  const request = typeof lastUserRequest === 'string' ? lastUserRequest : '';

  if (request && !summary.includes(request)) {
    lines.push(`- Last unfulfilled user request (verbatim): ${request}`);
  }

  for (const line of bulletLines(summary)) {
    if (line) lines.push(line);
  }

  const content = boundSummary(redactSummarySecrets(lines.join('\n')), maxChars);
  return Object.freeze({ role: 'system', content });
}

function normalizeSummaryText(value) {
  if (typeof value === 'string') return value.trim();
  if (value && typeof value === 'object') {
    return optionalString(value.summary ?? value.content ?? value.text) ?? '';
  }
  return '';
}

function stripDuplicatePrefix(value) {
  return value.startsWith(SUMMARY_PREFIX)
    ? value.slice(SUMMARY_PREFIX.length).trim()
    : value;
}

function bulletLines(value) {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const withoutBullet = line.replace(/^[-*]\s+/, '').trim();
      return withoutBullet ? `- ${withoutBullet}` : '';
    });
}

function boundSummary(value, maxChars) {
  const cap = positiveInteger(maxChars, SUMMARY_MAX_CHARS);
  if (value.length <= cap) return value;

  const suffix = '\n[summary truncated]';
  const prefixLength = Math.max(0, cap - suffix.length);
  return `${value.slice(0, prefixLength).trimEnd()}${suffix}`;
}

export function redactSummarySecrets(value) {
  return String(value ?? '')
    .replace(
      /\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Z0-9_]*\s*[:=]\s*)(["']?)[A-Za-z0-9._~+/=-]{8,}\2/gi,
      '$1[REDACTED]',
    )
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]');
}

function summaryContentBudget({ maxChars, head, tail }) {
  const remaining = maxChars - renderEntries([...head, ...tail]).length - 'system: '.length - 2;
  return Math.max(SUMMARY_PREFIX.length, Math.min(SUMMARY_MAX_CHARS, remaining));
}

function indexedEntries(history) {
  return history.map((entry, index) => normalizeEntry(entry, index)).filter(Boolean);
}

function normalizeEntry(entry, index) {
  const role = typeof entry?.role === 'string' ? entry.role : '';
  const label = ROLE_LABELS[role];
  const content = typeof entry?.content === 'string' ? entry.content : '';
  const lineContent = optionalString(content);
  if (!label || !lineContent) return null;

  return Object.freeze({
    index,
    role,
    label,
    content,
    lineContent,
  });
}

function outputEntry(entry) {
  return Object.freeze({ role: entry.role, content: entry.content });
}

function renderEntries(history) {
  return renderIndexedEntries(indexedEntries(history));
}

function renderIndexedEntries(entries) {
  return entries.map(renderIndexedEntry).filter(Boolean).join('\n');
}

function renderIndexedEntry(entry) {
  return `${entry.label}: ${entry.lineContent}`;
}

function lastUserContent(entries) {
  for (let offset = entries.length - 1; offset >= 0; offset -= 1) {
    if (entries[offset].role === 'user') return entries[offset].content;
  }
  return '';
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}
