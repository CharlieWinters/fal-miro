// Miro OAuth 2.0 authorization-code flow — the backend's own token, kept
// separate from the Web SDK's per-user in-app permissions. Needed for exactly
// one thing today: reading a Doc-format item's text content, which the Web
// SDK doesn't expose at all (see boardHelpers.getDocumentText on the
// frontend). Tokens are keyed by Miro user id, not board or team — mirrors
// how the Web SDK already acts "as that user".

import type { Context } from 'hono';
import { env } from 'hono/adapter';
import type { AppEnv, Bindings } from './env.js';
import { messageOf } from './errors.js';

export type StoredMiroToken = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
};

export interface MiroTokenStore {
  get(userId: string): Promise<StoredMiroToken | null>;
  put(userId: string, token: StoredMiroToken): Promise<void>;
}

// Fallback used when no MIRO_TOKENS KV binding is configured (i.e. every
// non-Workers runtime, and Workers deployments that skip the binding).
// node.ts injects a file-backed store here at boot via
// `setFallbackMiroTokenStore` — `tsx watch` restarts the whole process on
// every source-file save, and a plain in-memory Map was getting silently
// wiped by that on every edit, which is exactly what made this OAuth flow so
// confusing to test. Falls further back to a bare in-memory Map if nothing
// was ever injected (e.g. Workers without the KV binding) — fine for a
// single isolate's lifetime, same tradeoff as `modelsCache` in app.ts.
//
// `node:fs` itself never appears in this file on purpose — it's only ever
// imported in node.ts, which is never bundled into the Cloudflare Worker
// build (worker.ts only imports app.js), so this stays safe to import from
// code that IS shared between both runtimes.
let fallbackStore: MiroTokenStore | null = null;
const memoryStore = new Map<string, StoredMiroToken>();

export function setFallbackMiroTokenStore(store: MiroTokenStore): void {
  fallbackStore = store;
}

function kvKey(userId: string): string {
  return `miro-token:${userId}`;
}

function getTokenStore(c: Context<AppEnv>): MiroTokenStore {
  const { MIRO_TOKENS } = env<Bindings>(c);
  if (MIRO_TOKENS) {
    return {
      async get(userId) {
        const raw = await MIRO_TOKENS.get(kvKey(userId));
        return raw ? (JSON.parse(raw) as StoredMiroToken) : null;
      },
      async put(userId, token) {
        await MIRO_TOKENS.put(kvKey(userId), JSON.stringify(token));
      },
    };
  }
  if (fallbackStore) return fallbackStore;
  return {
    async get(userId) {
      return memoryStore.get(userId) ?? null;
    },
    async put(userId, token) {
      memoryStore.set(userId, token);
    },
  };
}

// The lone /v1 route in an otherwise-v2 API (see rest-api-reference skill).
const MIRO_TOKEN_URL = 'https://api.miro.com/v1/oauth/token';

type TokenResponse = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
};

async function requestToken(params: Record<string, string>): Promise<StoredMiroToken> {
  const url = new URL(MIRO_TOKEN_URL);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { method: 'POST' });
  const text = await res.text();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let payload: any = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    /* payload stays null; the raw text is still logged below */
  }
  if (!res.ok || !payload?.access_token) {
    console.error(`[miroOauth] token endpoint ${res.status} (grant_type=${params.grant_type}):`, text || '(empty body)');
    throw new Error(payload?.error_description ?? payload?.error ?? `Miro token endpoint ${res.status}`);
  }
  const parsed = payload as TokenResponse;
  console.log(
    `[miroOauth] token endpoint OK (grant_type=${params.grant_type}): expires_in=${parsed.expires_in} ` +
      `(type ${typeof parsed.expires_in}), has refresh_token=${Boolean(parsed.refresh_token)}, ` +
      `scope=${payload.scope ?? '(none)'}`,
  );
  return {
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token,
    // expires_in <= 0 (or missing) means "doesn't expire" — Miro apps have an
    // "Expire user authorization token" toggle; unchecked, it issues a
    // non-expiring token with expires_in: 0 and no refresh_token at all (no
    // need to refresh something that never expires). Use a very large but
    // finite timestamp rather than Infinity — Infinity serializes to `null`
    // through JSON.stringify, which would break the KV/file round-trip.
    expiresAt: parsed.expires_in > 0 ? Date.now() + parsed.expires_in * 1000 : Number.MAX_SAFE_INTEGER,
  };
}

export function exchangeMiroCode(opts: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): Promise<StoredMiroToken> {
  return requestToken({
    grant_type: 'authorization_code',
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    code: opts.code,
    redirect_uri: opts.redirectUri,
  });
}

function refreshMiroToken(opts: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<StoredMiroToken> {
  return requestToken({
    grant_type: 'refresh_token',
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    refresh_token: opts.refreshToken,
  });
}

export async function storeMiroToken(c: Context<AppEnv>, userId: string, token: StoredMiroToken): Promise<void> {
  await getTokenStore(c).put(userId, token);
}

/** Whether `userId` has ever connected their Miro account — doesn't refresh
 *  or validate the token, just reports presence, for a Settings-screen
 *  status indicator. */
export async function hasMiroToken(c: Context<AppEnv>, userId: string): Promise<boolean> {
  return (await getTokenStore(c).get(userId)) !== null;
}

/**
 * A valid access token for `userId`, refreshing first if it's within 60s of
 * expiring — access tokens last ~60 min, and refreshing **rotates** the
 * refresh token, so the new pair is written back before returning. Returns
 * null if this user has never connected their Miro account (no stored token
 * at all) — the caller should surface a "connect your Miro account" message.
 */
export async function getValidMiroAccessToken(
  c: Context<AppEnv>,
  userId: string,
  creds: { clientId: string; clientSecret: string },
): Promise<string | null> {
  const store = getTokenStore(c);
  const stored = await store.get(userId);
  if (!stored) {
    console.log(`[miroOauth] getValidMiroAccessToken: no stored token for userId=${userId}`);
    return null;
  }
  const msToExpiry = stored.expiresAt - Date.now();
  if (msToExpiry > 60_000) return stored.accessToken;

  // A near/past-expiry token with no refresh_token at all can't be
  // refreshed by definition — happens if a token was stored before the
  // "expires_in: 0 means never expires" fix, or the app config changes to
  // start expiring tokens without also granting refresh_token. Either way,
  // attempting the refresh call would just fail; return what we have rather
  // than a doomed request, and let the caller re-run the full connect flow
  // if this genuinely stopped working.
  if (!stored.refreshToken) {
    console.log(`[miroOauth] getValidMiroAccessToken: userId=${userId} has no refresh_token — reusing stored access token as-is`);
    return stored.accessToken;
  }

  console.log(
    `[miroOauth] getValidMiroAccessToken: token for userId=${userId} is expired/near-expiry ` +
      `(msToExpiry=${msToExpiry}, expiresAt=${stored.expiresAt}) — refreshing`,
  );

  try {
    const refreshed = await refreshMiroToken({
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      refreshToken: stored.refreshToken,
    });
    await store.put(userId, refreshed);
    return refreshed.accessToken;
  } catch (err) {
    console.error('[miroOauth] refresh failed:', messageOf(err));
    return null;
  }
}
