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
};

export type AppEnv = { Bindings: Bindings };

export type ResolvedEnv = {
  falKey?: string;
  adminKey?: string;
  backendKey?: string;
  allowedOrigins: string[];
  falPlatformApiBase: string;
  debug: boolean;
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
  // Off unless asked for. Debug logging summarizes every generation's input,
  // which is not something a fresh deployment should be doing by default.
  const debugRaw = e.DEBUG ?? '0';
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
  };
}
