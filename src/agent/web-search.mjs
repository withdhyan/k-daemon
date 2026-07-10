// Daemon-native web search — the implementation behind the grantable
// `web.search` tool.
//
// EGRESS: DuckDuckGo (html.duckduckgo.com) — a labeled, read-only outbound
// destination. Sends ONLY the model-composed query string (no substrate, no
// identifiers, no cookies). The founder accepts this query egress when they
// approve the backing Hermes skill (duckduckgo-search) via the staged-skills
// gate; the tool is never advertised without that grant.
//
// Own-lean: this adopts the Hermes skill's CONTRACT (DDG search), not its
// runtime — the SKILL.md assumes a shell + `ddgs` CLI we deliberately do not
// give foreign code. Failures are label-only (never echo upstream bodies).

import { optionalString } from '../substrate.mjs';

const DDG_HTML_URL = 'https://html.duckduckgo.com/html/';
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESULTS = 5;
const MAX_FIELD_CHARS = 240;
const MAX_QUERY_CHARS = 400;

/**
 * Execute a web search. Returns an executor-shaped result:
 * `{ ok, output?: { query, results: [{title, url, snippet}] }, reason? }`.
 */
export async function executeWebSearch(args = {}, opts = {}) {
  const query = optionalString(args.query)?.slice(0, MAX_QUERY_CHARS);
  if (!query) return { ok: false, reason: 'missing_query' };

  const count = boundCount(args.count);
  const fetchFn = opts.fetchImpl ?? globalThis.fetch;
  if (typeof fetchFn !== 'function') return { ok: false, reason: 'fetch_unavailable' };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetchFn(`${DDG_HTML_URL}?q=${encodeURIComponent(query)}`, {
      method: 'GET',
      headers: {
        // A plain browser-ish UA; DDG serves the parseable HTML endpoint to it.
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
        Accept: 'text/html',
      },
      signal: controller.signal,
    });

    if (!response?.ok) {
      // Label-only: never interpolate the upstream body.
      return { ok: false, reason: `search_failed_${response?.status ?? 'unknown'}` };
    }

    const html = await response.text();
    const results = parseDdgResults(html, count);
    if (results.length === 0) return { ok: false, reason: 'no_results' };

    // The tool-loop contract renders string output only — emit readable lines.
    const output = [
      `web search results for "${query}":`,
      ...results.map((r, i) => `${i + 1}. ${r.title} — ${r.snippet} (${r.url})`),
    ].join('\n');
    return { ok: true, output };
  } catch {
    return { ok: false, reason: 'search_failed' };
  } finally {
    clearTimeout(timeoutId);
  }
}

function boundCount(value) {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1) return MAX_RESULTS;
  return Math.min(count, MAX_RESULTS);
}

/**
 * Parse DDG's html endpoint: results are anchors with class `result__a`
 * (title + href) followed by a `result__snippet` element. Regex-parsed and
 * bounded — this is a read surface, not a DOM.
 */
export function parseDdgResults(html, count = MAX_RESULTS) {
  const source = typeof html === 'string' ? html : '';
  const results = [];
  const anchorPattern = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetPattern = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|td|span)>/g;

  const snippets = [];
  for (const match of source.matchAll(snippetPattern)) {
    snippets.push(cleanText(match[1]));
  }

  let index = 0;
  for (const match of source.matchAll(anchorPattern)) {
    if (results.length >= count) break;
    const url = decodeDdgHref(match[1]);
    const title = cleanText(match[2]);
    if (!url || !title) {
      index += 1;
      continue;
    }
    results.push({
      title: title.slice(0, MAX_FIELD_CHARS),
      url: url.slice(0, MAX_FIELD_CHARS),
      snippet: (snippets[index] ?? '').slice(0, MAX_FIELD_CHARS),
    });
    index += 1;
  }

  return results;
}

// DDG html endpoint wraps hrefs as /l/?uddg=<encoded-target>&…
function decodeDdgHref(href) {
  const raw = optionalString(href);
  if (!raw) return null;
  const uddg = raw.match(/[?&]uddg=([^&]+)/);
  if (uddg) {
    try {
      return decodeURIComponent(uddg[1]);
    } catch {
      return null;
    }
  }
  if (raw.startsWith('http://') || raw.startsWith('https://')) return raw;
  return null;
}

function cleanText(fragment) {
  return optionalString(
    String(fragment ?? '')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#x27;|&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim(),
  ) ?? '';
}
