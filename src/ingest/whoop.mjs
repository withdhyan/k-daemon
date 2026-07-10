import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  ROOT,
  safeDataPath,
} from '../../daemon/run.mjs';
import {
  createSubstrateStore,
  isPlainObject,
  optionalString,
  stripUndefined,
} from '../substrate.mjs';
import { bodyVitalRecordInputs } from './body-vitals.mjs';

export const WHOOP_AUTH_URL = 'https://api.prod.whoop.com/oauth/oauth2/auth';
export const WHOOP_TOKEN_URL = 'https://api.prod.whoop.com/oauth/oauth2/token';
export const WHOOP_API_BASE_URL = 'https://api.prod.whoop.com/developer/v2';
export const WHOOP_SCOPES = 'read:recovery read:sleep read:workout read:cycles read:body_measurement offline';
export const WHOOP_TOKENS_REL_PATH = path.join('whoop', 'tokens.json');
export const WHOOP_CURSOR_REL_PATH = path.join('whoop', 'cursor.json');
export const WHOOP_STATE_REL_PATH = path.join('whoop', 'oauth-state.json');

const TOKEN_EXPIRY_SKEW_MS = 60_000;
const STATE_TTL_MS = 15 * 60_000;
const ENDPOINTS = Object.freeze([
  Object.freeze({ key: 'recovery', path: '/recovery' }),
  Object.freeze({ key: 'sleep', path: '/activity/sleep' }),
  Object.freeze({ key: 'cycle', path: '/cycle' }),
  Object.freeze({ key: 'workout', path: '/activity/workout' }),
]);
const ZERO_COUNTS = Object.freeze({ recovery: 0, sleep: 0, cycle: 0, workout: 0 });

export function whoopConfig(env = process.env) {
  const clientId = optionalString(env?.WHOOP_CLIENT_ID);
  const clientSecret = optionalString(env?.WHOOP_CLIENT_SECRET);
  const redirectUri = optionalString(env?.WHOOP_REDIRECT_URI);
  return stripUndefined({
    configured: Boolean(clientId && clientSecret && redirectUri),
    clientId,
    clientSecret,
    redirectUri,
  });
}

export function whoopAuthorizeUrl({ env = process.env, state }) {
  const config = whoopConfig(env);
  if (!config.configured) throw new Error('WHOOP OAuth is not configured');
  const url = new URL(WHOOP_AUTH_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('scope', WHOOP_SCOPES);
  url.searchParams.set('state', requiredText(state, 'state'));
  return url.toString();
}

export async function syncWhoop(options = {}) {
  const dataDir = resolveDataDir(options.dataDir);
  const env = options.env ?? process.env;
  const config = whoopConfig(env);
  if (!config.configured) return skipResult('unconfigured', { configured: false, connected: false });

  const currentTokens = await readWhoopTokens({ dataDir });
  if (!currentTokens?.accessToken) {
    return skipResult('unconnected', { configured: true, connected: false });
  }
  if (whoopTokenExpired(currentTokens, options.now) && !currentTokens.refreshToken) {
    return skipResult('unconnected', { configured: true, connected: false });
  }

  try {
    const now = nowDate(options.now);
    const nowIso = now.toISOString();
    const fetchImpl = requiredFetch(options.fetchImpl);
    const tokens = await ensureWhoopAccessToken({
      dataDir,
      env,
      tokens: currentTokens,
      fetchImpl,
      now,
    });
    const cursor = await readWhoopCursor({ dataDir });
    const since = optionalString(cursor?.lastSyncAt);
    const collections = {};
    const counts = { ...ZERO_COUNTS };

    for (const endpoint of ENDPOINTS) {
      const records = await fetchWhoopCollection({
        endpoint,
        accessToken: tokens.accessToken,
        fetchImpl,
        since,
      });
      collections[endpoint.key] = records;
      counts[endpoint.key] = records.length;
    }

    const payload = whoopBodyVitalPayload(collections, {
      ingestedAt: nowIso,
      consentGrantedAt: tokens.obtainedAt ?? nowIso,
      scope: tokens.scope ?? WHOOP_SCOPES,
    });
    const result = bodyVitalRecordInputs(payload);
    const store = options.store ??
      createSubstrateStore({
        dataDir,
        now: () => now,
      });
    let createdCount = 0;
    let duplicateCount = 0;

    for (const sample of result.samples) {
      const write = await store.writeVitalRecord(sample, { withWriteResult: true });
      if (write.created) {
        createdCount += 1;
      } else {
        duplicateCount += 1;
      }
    }

    await writeWhoopCursor({
      dataDir,
      cursor: {
        schemaVersion: 1,
        lastSyncAt: nowIso,
        previousSyncAt: since,
        counts,
        vitalCount: result.samples.length,
        skippedCount: result.skippedCount,
        createdCount,
        duplicateCount,
      },
    });

    return {
      skipped: false,
      configured: true,
      connected: true,
      lastSyncAt: nowIso,
      createdCount,
      duplicateCount,
      skippedCount: result.skippedCount,
      vitalCount: result.samples.length,
      counts,
    };
  } catch (error) {
    return {
      skipped: true,
      reason: 'api_failure',
      configured: true,
      connected: true,
      createdCount: 0,
      duplicateCount: 0,
      counts: { ...ZERO_COUNTS },
      backoff: true,
      message: optionalString(error?.message) ?? 'WHOOP API failure',
    };
  }
}

export async function whoopStatus(options = {}) {
  const dataDir = resolveDataDir(options.dataDir);
  const config = whoopConfig(options.env ?? process.env);
  const tokens = await readWhoopTokens({ dataDir });
  const cursor = await readWhoopCursor({ dataDir });
  return {
    configured: config.configured,
    connected: Boolean(config.configured && tokens?.accessToken),
    lastSyncAt: optionalString(cursor?.lastSyncAt) ?? null,
    counts: normalizeCounts(cursor?.counts),
  };
}

export async function exchangeWhoopAuthorizationCode({
  dataDir,
  env = process.env,
  code,
  fetchImpl,
  now,
}) {
  const config = whoopConfig(env);
  if (!config.configured) throw new Error('WHOOP OAuth is not configured');
  const body = tokenRequestBody({
    grant_type: 'authorization_code',
    code: requiredText(code, 'code'),
    redirect_uri: config.redirectUri,
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });
  const tokenResponse = await postWhoopToken({ body, fetchImpl: requiredFetch(fetchImpl) });
  return writeWhoopTokens({
    dataDir: resolveDataDir(dataDir),
    tokens: normalizeTokenResponse(tokenResponse, { now: nowDate(now) }),
  });
}

export async function refreshWhoopTokens({
  dataDir,
  env = process.env,
  tokens,
  fetchImpl,
  now,
}) {
  const config = whoopConfig(env);
  if (!config.configured) throw new Error('WHOOP OAuth is not configured');
  const refreshToken = optionalString(tokens?.refreshToken);
  if (!refreshToken) throw new Error('WHOOP refresh token is missing');
  const body = tokenRequestBody({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });
  const tokenResponse = await postWhoopToken({ body, fetchImpl: requiredFetch(fetchImpl) });
  return writeWhoopTokens({
    dataDir: resolveDataDir(dataDir),
    tokens: {
      ...normalizeTokenResponse(tokenResponse, { now: nowDate(now) }),
      refreshToken: optionalString(tokenResponse.refresh_token) ?? refreshToken,
    },
  });
}

export async function ensureWhoopAccessToken({
  dataDir,
  env = process.env,
  tokens,
  fetchImpl,
  now,
}) {
  if (!tokens?.accessToken) throw new Error('WHOOP access token is missing');
  if (!whoopTokenExpired(tokens, now)) return tokens;
  return refreshWhoopTokens({ dataDir, env, tokens, fetchImpl, now });
}

export async function fetchWhoopCollection({
  endpoint,
  accessToken,
  fetchImpl,
  since,
}) {
  const records = [];
  let nextToken;

  do {
    const url = new URL(`${WHOOP_API_BASE_URL}${endpoint.path}`);
    if (nextToken) {
      url.searchParams.set('nextToken', nextToken);
    } else if (since) {
      url.searchParams.set('start', since);
    }
    const body = await fetchWhoopJson(url, {
      fetchImpl: requiredFetch(fetchImpl),
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${requiredText(accessToken, 'accessToken')}`,
      },
    });
    records.push(...recordsFromWhoopResponse(body, endpoint.key));
    nextToken = nextTokenFromWhoopResponse(body);
  } while (nextToken);

  return records;
}

export function whoopBodyVitalPayload(collections, options = {}) {
  const samples = [
    ...arrayValues(collections?.recovery).map(mapWhoopRecovery).filter(Boolean),
    ...arrayValues(collections?.sleep).map(mapWhoopSleep).filter(Boolean),
    ...arrayValues(collections?.cycle).map(mapWhoopCycle).filter(Boolean),
    ...arrayValues(collections?.workout).map(mapWhoopWorkout).filter(Boolean),
  ];

  return {
    consent: {
      offPhone: true,
      scope: optionalString(options.scope) ?? WHOOP_SCOPES,
      grantedAt: optionalIso(options.consentGrantedAt),
    },
    source: 'whoop',
    ingested_at: optionalIso(options.ingestedAt),
    samples,
  };
}

export async function readWhoopTokens({ dataDir }) {
  return readJsonIfExists(whoopDataPath(resolveDataDir(dataDir), WHOOP_TOKENS_REL_PATH));
}

export async function writeWhoopTokens({ dataDir, tokens }) {
  const normalized = normalizeStoredTokens(tokens, nowDate(tokens?.now));
  await atomicWriteJson(whoopDataPath(resolveDataDir(dataDir), WHOOP_TOKENS_REL_PATH), normalized);
  return normalized;
}

export async function readWhoopCursor({ dataDir }) {
  return readJsonIfExists(whoopDataPath(resolveDataDir(dataDir), WHOOP_CURSOR_REL_PATH));
}

export async function writeWhoopCursor({ dataDir, cursor }) {
  await atomicWriteJson(whoopDataPath(resolveDataDir(dataDir), WHOOP_CURSOR_REL_PATH), cursor);
  return cursor;
}

export async function writeWhoopOAuthState({
  dataDir,
  state,
  now,
}) {
  const record = {
    state: requiredText(state, 'state'),
    createdAt: nowDate(now).toISOString(),
  };
  await atomicWriteJson(whoopDataPath(resolveDataDir(dataDir), WHOOP_STATE_REL_PATH), record);
  return record;
}

export async function consumeWhoopOAuthState({
  dataDir,
  state,
  now,
}) {
  const file = whoopDataPath(resolveDataDir(dataDir), WHOOP_STATE_REL_PATH);
  const record = await readJsonIfExists(file);
  if (!record || optionalString(record.state) !== optionalString(state)) return false;

  const createdAt = new Date(record.createdAt);
  if (Number.isNaN(createdAt.getTime()) || nowDate(now).getTime() - createdAt.getTime() > STATE_TTL_MS) {
    return false;
  }

  await fs.unlink(file).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
  return true;
}

export function newWhoopState() {
  return randomBytes(24).toString('hex');
}

function mapWhoopRecovery(record) {
  const score = scoreObject(record);
  const recoveryScore = firstFinite(
    score.recovery_score,
    score.recoveryScore,
    record.recovery_score,
    record.recoveryScore,
  );
  const hrvMs = firstFinite(
    score.hrv_rmssd_milli,
    score.hrvRmssdMilli,
    score.hrv_ms,
    score.hrvMs,
    score.rmssd_ms,
    score.rmssdMs,
    record.hrv_ms,
    record.hrvMs,
  );
  const restingHeartRate = firstFinite(
    score.resting_heart_rate,
    score.restingHeartRate,
    score.rhr,
    record.resting_heart_rate,
    record.restingHeartRate,
  );
  const id = firstText(record.id, record.recovery_id, record.cycle_id, record.sleep_id, timestampFor(record));
  const eventAt = timestampFor(record);

  if (recoveryScore === undefined && hrvMs === undefined && restingHeartRate === undefined) return null;
  return stripUndefined({
    kind: 'recovery',
    source: 'whoop',
    source_id: `whoop:recovery:${id}`,
    timestamp: eventAt,
    whoop_recovery: recoveryScore,
    hrv_ms: hrvMs,
    resting_heart_rate: restingHeartRate,
    sourceType: 'whoop_recovery',
  });
}

function mapWhoopSleep(record) {
  const score = scoreObject(record);
  const stage = firstPlainObject(
    score.stage_summary,
    score.stageSummary,
    record.stage_summary,
    record.stageSummary,
  );
  const deepSleepMinutes = millisToMinutes(firstFinite(
    stage?.total_slow_wave_sleep_time_milli,
    stage?.totalSlowWaveSleepTimeMilli,
    stage?.deep_sleep_milli,
    stage?.deepSleepMilli,
    record.deep_sleep_milli,
  ));
  const remSleepMinutes = millisToMinutes(firstFinite(
    stage?.total_rem_sleep_time_milli,
    stage?.totalRemSleepTimeMilli,
    stage?.rem_sleep_milli,
    stage?.remSleepMilli,
    record.rem_sleep_milli,
  ));
  const awakeMinutes = millisToMinutes(firstFinite(
    stage?.total_awake_time_milli,
    stage?.totalAwakeTimeMilli,
    stage?.awake_time_milli,
    stage?.awakeTimeMilli,
    record.awake_time_milli,
  ));
  const lightSleepMinutes = millisToMinutes(firstFinite(
    stage?.total_light_sleep_time_milli,
    stage?.totalLightSleepTimeMilli,
    stage?.light_sleep_milli,
    stage?.lightSleepMilli,
    record.light_sleep_milli,
  ));
  const durationMinutes = firstFinite(
    millisToMinutes(firstFinite(
      stage?.total_sleep_time_milli,
      stage?.totalSleepTimeMilli,
      score.total_sleep_time_milli,
      score.totalSleepTimeMilli,
      record.total_sleep_time_milli,
      record.totalSleepTimeMilli,
    )),
    sumFinite(lightSleepMinutes, deepSleepMinutes, remSleepMinutes),
  );
  const sleepEfficiency = firstFinite(
    score.sleep_efficiency_percentage,
    score.sleepEfficiencyPercentage,
    score.sleep_efficiency,
    score.sleepEfficiency,
    record.sleep_efficiency,
  );
  const sleepScore = firstFinite(
    score.sleep_performance_percentage,
    score.sleepPerformancePercentage,
    score.sleep_score,
    score.sleepScore,
    record.sleep_score,
  );
  const id = firstText(record.id, record.sleep_id, record.cycle_id, timestampFor(record));

  if (
    durationMinutes === undefined &&
    sleepScore === undefined &&
    sleepEfficiency === undefined &&
    deepSleepMinutes === undefined &&
    remSleepMinutes === undefined &&
    awakeMinutes === undefined
  ) {
    return null;
  }

  return stripUndefined({
    kind: 'sleep',
    source: 'whoop',
    source_id: `whoop:sleep:${id}`,
    start_at: optionalIso(record.start ?? record.start_at ?? record.startAt),
    end_at: optionalIso(record.end ?? record.end_at ?? record.endAt),
    timestamp: timestampFor(record),
    duration_minutes: durationMinutes,
    sleep_score: sleepScore,
    sleep_efficiency: sleepEfficiency,
    deep_sleep_minutes: deepSleepMinutes,
    rem_sleep_minutes: remSleepMinutes,
    awake_minutes: awakeMinutes,
    sourceType: 'whoop_sleep',
  });
}

function mapWhoopCycle(record) {
  const score = scoreObject(record);
  const strain = firstFinite(score.strain, score.day_strain, score.dayStrain, record.strain, record.day_strain);
  if (strain === undefined) return null;
  const id = firstText(record.id, record.cycle_id, timestampFor(record));
  return stripUndefined({
    kind: 'recovery',
    source: 'whoop',
    source_id: `whoop:cycle:${id}`,
    start_at: optionalIso(record.start ?? record.start_at ?? record.startAt),
    end_at: optionalIso(record.end ?? record.end_at ?? record.endAt),
    timestamp: timestampFor(record),
    strain,
    sourceType: 'whoop_cycle',
  });
}

function mapWhoopWorkout(record) {
  const score = scoreObject(record);
  const strain = firstFinite(score.strain, score.workout_strain, score.workoutStrain, record.strain);
  if (strain === undefined) return null;
  const id = firstText(record.id, record.workout_id, timestampFor(record));
  return stripUndefined({
    kind: 'recovery',
    source: 'whoop',
    source_id: `whoop:workout:${id}`,
    start_at: optionalIso(record.start ?? record.start_at ?? record.startAt),
    end_at: optionalIso(record.end ?? record.end_at ?? record.endAt),
    timestamp: timestampFor(record),
    strain,
    sourceType: 'whoop_workout',
  });
}

async function postWhoopToken({ body, fetchImpl }) {
  return fetchWhoopJson(WHOOP_TOKEN_URL, {
    fetchImpl,
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body,
  });
}

const WHOOP_REQUEST_SPACING_MS = 1_500;
const WHOOP_RATE_LIMIT_RETRY_MS = 65_000;
let lastWhoopRequestAt = 0;

async function fetchWhoopJson(url, options = {}) {
  const fetchImpl = requiredFetch(options.fetchImpl);
  const sleepImpl = options.sleepImpl ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  // Pace requests: the sync fans out over 4 collections × pages and otherwise
  // trips WHOOP's per-minute limit mid-run; one 429 then aborts the whole sync.
  if (options.paced !== false) {
    const wait = lastWhoopRequestAt + WHOOP_REQUEST_SPACING_MS - Date.now();
    if (wait > 0) await sleepImpl(wait);
  }
  lastWhoopRequestAt = Date.now();
  let response = await fetchImpl(String(url), {
    method: options.method ?? 'GET',
    headers: options.headers,
    body: options.body,
  });
  if (response?.status === 429 && options.retried !== true) {
    await sleepImpl(WHOOP_RATE_LIMIT_RETRY_MS);
    lastWhoopRequestAt = Date.now();
    response = await fetchImpl(String(url), {
      method: options.method ?? 'GET',
      headers: options.headers,
      body: options.body,
    });
  }
  if (!response?.ok) {
    const text = typeof response?.text === 'function' ? await response.text() : '';
    throw new Error(`WHOOP request failed (${response?.status ?? 'unknown'}): ${text || response?.statusText || 'unknown error'}`);
  }
  return response.json();
}

function recordsFromWhoopResponse(body, key) {
  if (Array.isArray(body)) return body;
  if (!isPlainObject(body)) return [];
  const direct = body.records ?? body.data ?? body[key];
  if (Array.isArray(direct)) return direct;
  const plural = {
    recovery: 'recoveries',
    sleep: 'sleeps',
    cycle: 'cycles',
    workout: 'workouts',
  }[key];
  return Array.isArray(body[plural]) ? body[plural] : [];
}

function nextTokenFromWhoopResponse(body) {
  return firstText(
    body?.nextToken,
    body?.next_token,
    body?.pagination?.nextToken,
    body?.pagination?.next_token,
  );
}

function normalizeTokenResponse(response, { now }) {
  const expiresIn = firstFinite(response?.expires_in, response?.expiresIn);
  return normalizeStoredTokens({
    accessToken: response?.access_token ?? response?.accessToken,
    refreshToken: response?.refresh_token ?? response?.refreshToken,
    tokenType: response?.token_type ?? response?.tokenType ?? 'Bearer',
    scope: response?.scope ?? WHOOP_SCOPES,
    expiresAt: expiresIn === undefined ? response?.expires_at ?? response?.expiresAt : new Date(now.getTime() + expiresIn * 1000).toISOString(),
    obtainedAt: now.toISOString(),
  }, now);
}

function normalizeStoredTokens(tokens, now) {
  const accessToken = optionalString(tokens?.accessToken ?? tokens?.access_token);
  const refreshToken = optionalString(tokens?.refreshToken ?? tokens?.refresh_token);
  if (!accessToken && !refreshToken) throw new Error('WHOOP tokens require an access or refresh token');
  const expiresIn = firstFinite(tokens?.expiresIn, tokens?.expires_in);
  const expiresAt = optionalIso(tokens?.expiresAt ?? tokens?.expires_at) ??
    (expiresIn === undefined ? undefined : new Date(now.getTime() + expiresIn * 1000).toISOString());
  return stripUndefined({
    accessToken,
    refreshToken,
    tokenType: optionalString(tokens?.tokenType ?? tokens?.token_type) ?? 'Bearer',
    scope: optionalString(tokens?.scope),
    expiresAt,
    obtainedAt: optionalIso(tokens?.obtainedAt ?? tokens?.obtained_at) ?? now.toISOString(),
  });
}

function tokenRequestBody(values) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    const text = optionalString(value);
    if (text) params.set(key, text);
  }
  return params.toString();
}

function whoopTokenExpired(tokens, now) {
  const expiresAt = optionalString(tokens?.expiresAt);
  if (!expiresAt) return false;
  const date = new Date(expiresAt);
  if (Number.isNaN(date.getTime())) return true;
  return date.getTime() <= nowDate(now).getTime() + TOKEN_EXPIRY_SKEW_MS;
}

function skipResult(reason, fields) {
  return {
    skipped: true,
    reason,
    configured: fields.configured,
    connected: fields.connected,
    createdCount: 0,
    duplicateCount: 0,
    counts: { ...ZERO_COUNTS },
  };
}

function normalizeCounts(counts) {
  return {
    recovery: Math.max(0, Math.floor(Number(counts?.recovery ?? 0))) || 0,
    sleep: Math.max(0, Math.floor(Number(counts?.sleep ?? 0))) || 0,
    cycle: Math.max(0, Math.floor(Number(counts?.cycle ?? 0))) || 0,
    workout: Math.max(0, Math.floor(Number(counts?.workout ?? 0))) || 0,
  };
}

function scoreObject(record) {
  return firstPlainObject(record?.score, record?.scores) ?? {};
}

function firstPlainObject(...values) {
  return values.find((value) => isPlainObject(value));
}

function firstFinite(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return undefined;
}

function firstText(...values) {
  for (const value of values) {
    const text = optionalString(value);
    if (text) return text;
  }
  return undefined;
}

function sumFinite(...values) {
  const finite = values.filter((value) => Number.isFinite(value));
  return finite.length > 0 ? finite.reduce((sum, value) => sum + value, 0) : undefined;
}

function millisToMinutes(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return undefined;
  return Math.round((number / 60_000) * 10) / 10;
}

function timestampFor(record) {
  return optionalIso(
    record?.end ??
      record?.end_at ??
      record?.endAt ??
      record?.updated_at ??
      record?.updatedAt ??
      record?.created_at ??
      record?.createdAt ??
      record?.start ??
      record?.start_at ??
      record?.startAt,
  );
}

function optionalIso(value) {
  const text = optionalString(value);
  if (!text) return undefined;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function arrayValues(value) {
  return Array.isArray(value) ? value : [];
}

function requiredText(value, label) {
  const text = optionalString(value);
  if (!text) throw new Error(`${label} is required`);
  return text;
}

function requiredFetch(fetchImpl) {
  const impl = fetchImpl ?? globalThis.fetch;
  if (typeof impl !== 'function') throw new Error('fetch implementation is required');
  return impl;
}

function nowDate(value) {
  const raw = typeof value === 'function' ? value() : value;
  const date = raw instanceof Date ? raw : raw ? new Date(raw) : new Date();
  if (Number.isNaN(date.getTime())) throw new Error(`invalid date: ${raw}`);
  return date;
}

function resolveDataDir(dataDir) {
  return path.resolve(dataDir ?? path.join(ROOT, 'data'));
}

function whoopDataPath(dataDir, relPath) {
  return safeDataPath(dataDir, relPath);
}

async function readJsonIfExists(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function atomicWriteJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`,
  );
  try {
    await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await fs.rename(temp, file);
  } catch (error) {
    await fs.unlink(temp).catch(() => {});
    throw error;
  }
}
