import {
  consumeWhoopOAuthState,
  exchangeWhoopAuthorizationCode,
  newWhoopState,
  whoopAuthorizeUrl,
  whoopConfig,
  whoopStatus,
  writeWhoopOAuthState,
} from '../../src/ingest/whoop.mjs';
import { optionalString } from '../../src/substrate.mjs';

export const WHOOP_CONNECT_PATH = '/api/whoop/connect';
export const WHOOP_CALLBACK_PATH = '/api/whoop/callback';
export const WHOOP_STATUS_PATH = '/api/whoop/status';

const WHOOP_PATHS = new Set([
  WHOOP_CONNECT_PATH,
  WHOOP_CALLBACK_PATH,
  WHOOP_STATUS_PATH,
]);

export function isWhoopPath(pathname) {
  return WHOOP_PATHS.has(pathname);
}

export async function handleWhoopRoute(request, response, context, deps) {
  const { method, pathname } = context;
  const { sendJson } = deps;
  const whoopDeps = context.whoop ?? {};
  const env = whoopDeps.env ?? process.env;
  const now = context.now;
  const dataDir = context.dataDir;
  const searchParams = context.searchParams ??
    new URL(request.url ?? '/', 'http://127.0.0.1').searchParams;

  if (method === 'GET' && pathname === WHOOP_STATUS_PATH) {
    sendJson(response, 200, await whoopStatus({ dataDir, env, now }));
    return true;
  }

  if (method === 'GET' && pathname === WHOOP_CONNECT_PATH) {
    const config = whoopConfig(env);
    if (!config.configured) {
      sendJson(response, 503, { ok: false, error: 'whoop_unconfigured' });
      return true;
    }

    const state = typeof whoopDeps.state === 'function'
      ? optionalString(whoopDeps.state())
      : optionalString(whoopDeps.state);
    const nonce = state ?? newWhoopState();
    await writeWhoopOAuthState({ dataDir, state: nonce, now });
    response.writeHead(302, { location: whoopAuthorizeUrl({ env, state: nonce }) });
    response.end();
    return true;
  }

  if (method === 'GET' && pathname === WHOOP_CALLBACK_PATH) {
    const state = searchParams.get('state');
    const code = searchParams.get('code');
    if (!optionalString(code) || !optionalString(state)) {
      sendText(response, 400, 'WHOOP authorization failed: missing code or state\n');
      return true;
    }

    const stateMatches = await consumeWhoopOAuthState({ dataDir, state, now });
    if (!stateMatches) {
      sendText(response, 400, 'WHOOP authorization failed: state mismatch\n');
      return true;
    }

    try {
      await exchangeWhoopAuthorizationCode({
        dataDir,
        env,
        code,
        fetchImpl: whoopDeps.fetchImpl,
        now,
      });
    } catch (error) {
      sendText(response, 502, `WHOOP authorization failed: ${optionalString(error?.message) ?? 'token exchange failed'}\n`);
      return true;
    }

    sendText(response, 200, 'WHOOP connected. You can close this window.\n');
    return true;
  }

  if (isWhoopPath(pathname)) {
    sendJson(response, 405, { ok: false, error: 'method_not_allowed' });
    return true;
  }

  return false;
}

function sendText(response, status, body) {
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  response.end(body);
}
