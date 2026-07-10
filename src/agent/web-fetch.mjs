// Daemon-native web page fetch - the implementation behind the grantable
// `web.fetch` tool.
//
// EGRESS: arbitrary http(s) page fetch. This is grant-gated outward IO under
// the same founder-approved Hermes skill as `web.search`: approving
// duckduckgo-search covers following search results to read pages. The tool is
// never advertised without that capability grant.
//
// Failures are label-only. Never echo upstream response bodies into errors.

import { lookup } from 'node:dns/promises';
import net from 'node:net';

import { optionalString } from '../substrate.mjs';

const DEFAULT_MAX_CHARS = 6000;
const MAX_REQUESTED_CHARS = 20_000;
const MAX_HTML_CHARS = 250_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const REDIRECT_LIMIT = 3;
const TITLE_MAX_CHARS = 240;

/**
 * Read-only GET of a public http(s) URL.
 *
 * @returns {Promise<{ok: boolean, output?: string, reason?: string}>}
 */
export async function executeWebFetch(args = {}, opts = {}) {
  const requestedUrl = optionalString(args.url);
  if (!requestedUrl) return { ok: false, reason: 'missing_url' };

  const fetchFn = opts.fetchImpl ?? globalThis.fetch;
  if (typeof fetchFn !== 'function') return { ok: false, reason: 'fetch_unavailable' };

  let currentUrl;
  try {
    currentUrl = new URL(requestedUrl);
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }

  const maxChars = boundMaxChars(args.maxChars);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let redirects = 0;

  try {
    while (true) {
      await assertPublicHttpUrl(currentUrl, opts);

      const response = await fetchFn(currentUrl.href, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          'User-Agent': 'cs-k-agent/1.0',
          Accept: 'text/html, text/plain;q=0.9, */*;q=0.8',
        },
        signal: controller.signal,
      });

      if (isRedirectStatus(response?.status)) {
        if (redirects >= REDIRECT_LIMIT) return { ok: false, reason: 'too_many_redirects' };
        const location = responseHeader(response, 'location');
        if (!location) return { ok: false, reason: 'redirect_missing_location' };
        currentUrl = new URL(location, currentUrl);
        redirects += 1;
        continue;
      }

      if (!response?.ok) {
        return { ok: false, reason: `fetch_failed_${response?.status ?? 'unknown'}` };
      }

      const html = await readResponseText(response);
      const title = extractTitle(html);
      const text = extractReadableText(html, maxChars);
      return {
        ok: true,
        output: `fetched ${currentUrl.href}:\n${title}\n${text}`,
      };
    }
  } catch (error) {
    if (error?.name === 'AbortError') return { ok: false, reason: 'fetch_timeout' };
    if (error instanceof WebFetchGuardError) return { ok: false, reason: error.reason };
    return { ok: false, reason: 'fetch_failed' };
  } finally {
    clearTimeout(timeoutId);
  }
}

function boundMaxChars(value) {
  const number = Number(value ?? DEFAULT_MAX_CHARS);
  if (!Number.isInteger(number) || number < 1) return DEFAULT_MAX_CHARS;
  return Math.min(number, MAX_REQUESTED_CHARS);
}

async function assertPublicHttpUrl(url, opts) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new WebFetchGuardError('unsupported_scheme');
  }
  const hostname = normalizedHostname(url.hostname);
  if (!hostname) throw new WebFetchGuardError('invalid_url');

  const addresses = await resolveHost(hostname, opts.resolveHost ?? defaultResolveHost);
  if (addresses.length === 0) throw new WebFetchGuardError('resolve_failed');
  if (addresses.some((address) => isBlockedIp(address))) {
    throw new WebFetchGuardError('blocked_url');
  }
}

async function defaultResolveHost(hostname) {
  if (net.isIP(hostname)) return [hostname];
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

async function resolveHost(hostname, resolveImpl) {
  try {
    const records = await resolveImpl(hostname);
    const list = Array.isArray(records) ? records : [records];
    return list
      .map((record) => optionalString(record?.address ?? record))
      .filter(Boolean)
      .map(normalizedHostname);
  } catch {
    throw new WebFetchGuardError('resolve_failed');
  }
}

function normalizedHostname(hostname) {
  return (optionalString(hostname) ?? '')
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();
}

function isBlockedIp(address) {
  const host = normalizedHostname(address);
  const mapped = ipv4FromMappedIpv6(host);
  const ipv4 = mapped ?? (net.isIP(host) === 4 ? host : null);
  if (ipv4) return isBlockedIpv4(ipv4);
  if (net.isIP(host) !== 6) return false;

  if (host === '::' || host === '::1') return true;
  const first = parseInt(host.split(':', 1)[0] || '0', 16);
  if (!Number.isFinite(first)) return true;
  return (
    (first & 0xfe00) === 0xfc00 || // fc00::/7 unique-local
    (first & 0xffc0) === 0xfe80 // fe80::/10 link-local
  );
}

function isBlockedIpv4(address) {
  const octets = address.split('.').map((part) => Number(part));
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function ipv4FromMappedIpv6(address) {
  const match = address.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  return match ? match[1] : null;
}

function isRedirectStatus(status) {
  return [301, 302, 303, 307, 308].includes(Number(status));
}

function responseHeader(response, name) {
  const headers = response?.headers;
  if (typeof headers?.get === 'function') return optionalString(headers.get(name));
  if (headers instanceof Map) return optionalString(headers.get(name) ?? headers.get(name.toLowerCase()));
  if (headers && typeof headers === 'object') {
    return optionalString(headers[name] ?? headers[name.toLowerCase()]);
  }
  return null;
}

async function readResponseText(response) {
  if (response?.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (text.length < MAX_HTML_CHARS) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text.slice(0, MAX_HTML_CHARS);
  }

  if (typeof response?.text !== 'function') return '';
  return String(await response.text()).slice(0, MAX_HTML_CHARS);
}

function extractTitle(html) {
  const match = String(html ?? '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return cleanText(match?.[1] ?? '').slice(0, TITLE_MAX_CHARS);
}

export function extractReadableText(html, maxChars = DEFAULT_MAX_CHARS) {
  const text = String(html ?? '')
    .replace(/<head\b[\s\S]*?(?:<\/head>|$)/gi, ' ')
    .replace(/<title\b[\s\S]*?(?:<\/title>|$)/gi, ' ')
    .replace(/<script\b[\s\S]*?(?:<\/script>|$)/gi, ' ')
    .replace(/<style\b[\s\S]*?(?:<\/style>|$)/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ');
  return cleanText(text).slice(0, boundMaxChars(maxChars));
}

function cleanText(value) {
  return decodeHtmlEntities(String(value ?? ''))
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeHtmlEntities(value) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, decimal) => fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_match, name) => ({
      amp: '&',
      lt: '<',
      gt: '>',
      quot: '"',
      apos: "'",
      nbsp: ' ',
    }[name] ?? ''));
}

function fromCodePoint(value) {
  if (!Number.isInteger(value) || value < 0 || value > 0x10ffff) return '';
  try {
    return String.fromCodePoint(value);
  } catch {
    return '';
  }
}

class WebFetchGuardError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'WebFetchGuardError';
    this.reason = reason;
  }
}
