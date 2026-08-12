import type { Context } from 'hono';
import { env } from 'hono/adapter';

// Bindings shape shared by every runtime: process.env on Node/Bun/Deno,
// wrangler-configured vars/secrets (c.env) on Cloudflare Workers.
export type Bindings = {
  FAL_KEY?: string;
  ADMIN_KEY?: string;
  // Shared secret every caller of /api/fal/* must send back as the
  // x-fal-proxy-key header. Without this, anyone who finds a deployed
  // instance's URL could hit /api/fal/run directly and spend its FAL_KEY
  // credits — CORS' Access-Control-Allow-Origin only stops browsers from
  // reading the response, it never stops the request from being sent.
  BACKEND_KEY?: string;
  ALLOWED_ORIGINS?: string;
  FAL_PLATFORM_API_BASE?: string;
  DEBUG?: string;
  // Miro OAuth (authorization-code flow) — lets the backend read Doc-format
  // item content via the REST API, the one thing the Web SDK can't do. See
  // lib/miroOauth.ts. Client id/secret come from the app's entry in Miro's
  // "Your apps" dashboard; the redirect URI must exactly match what's
  // registered there.
  MIRO_CLIENT_ID?: string;
  MIRO_CLIENT_SECRET?: string;
  MIRO_REDIRECT_URI?: string;
  // Optional Workers KV binding for OAuth token storage (see wrangler.toml).
  // Falls back to an in-memory store when absent — fine for local/self-hosted
  // use, lost on restart. Not read through ResolvedEnv below since it's a
  // binding object, not a plain config value; lib/miroOauth.ts reads it
  // directly via hono/adapter's env().
  MIRO_TOKENS?: KVNamespace;
};

export type AppEnv = { Bindings: Bindings };

export type ResolvedEnv = {
  falKey?: string;
  adminKey?: string;
  backendKey?: string;
  allowedOrigins: string[];
  falPlatformApiBase: string;
  debug: boolean;
  miroClientId?: string;
  miroClientSecret?: string;
  miroRedirectUri?: string;
};

/**
 * Read env vars the way that works on every Hono runtime (see hono/adapter's
 * `env()`), then apply this app's defaults/parsing. Called per-request rather
 * than once at module load, since Workers only exposes bindings via the
 * request context — there's no module-scope "boot" env like Node's
 * `process.env`.
 */
export function resolveEnv(c: Context<AppEnv>): ResolvedEnv {
  const e = env<Bindings>(c);
  const debugRaw = e.DEBUG ?? '1';
  return {
    falKey: e.FAL_KEY,
    adminKey: e.ADMIN_KEY,
    backendKey: e.BACKEND_KEY,
    allowedOrigins: (e.ALLOWED_ORIGINS ?? 'http://localhost:5175')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    falPlatformApiBase: e.FAL_PLATFORM_API_BASE ?? 'https://api.fal.ai/v1',
    debug: debugRaw !== '0' && debugRaw !== 'false',
    miroClientId: e.MIRO_CLIENT_ID,
    miroClientSecret: e.MIRO_CLIENT_SECRET,
    miroRedirectUri: e.MIRO_REDIRECT_URI,
  };
}
