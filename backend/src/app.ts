import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
import { fal } from '@fal-ai/client';

import { type AppEnv, resolveEnv } from './lib/env.js';
import { logBox, summarizeInput } from './lib/logging.js';
import { extractOutputUrls, normalizeStatus } from './lib/output.js';
import { falError, messageOf } from './lib/errors.js';
import { jsonResponse } from './lib/http.js';

// Runtime-agnostic Hono app — the same routes/logic run on Node
// (src/node.ts) and Cloudflare Workers (src/worker.ts). The FAL_KEY lives
// only here — the frontend always goes through these routes.
export const app = new Hono<AppEnv>();

app.use(
  '*',
  cors({
    origin: (origin, c) => {
      // No Origin header at all (server-to-server / same-origin / curl) isn't
      // a browser CORS request in the first place — decline to add the
      // header rather than erroring. Routes that must be cross-origin
      // readable (e.g. /proxy) set their own Access-Control-Allow-Origin.
      if (!origin) return null;
      const { allowedOrigins } = resolveEnv(c);
      return allowedOrigins.includes(origin) ? origin : null;
    },
    allowMethods: ['GET', 'POST'],
    allowHeaders: ['Content-Type', 'x-fal-proxy-key'],
  }),
);

// ---------------------------------------------------------------------------
// Auth — every /api/fal/* call must send back the shared secret configured as
// BACKEND_KEY. This is the actual access control: the CORS config above only
// stops a *browser* from reading a disallowed origin's response — it does
// nothing to stop a direct curl/script call from reaching these routes and
// spending this deployment's FAL_KEY credits. Fails closed: an unconfigured
// BACKEND_KEY blocks every request rather than silently allowing them.
//
// /embed/* and /proxy are deliberately exempt from this check — they're
// loaded via <iframe>/<img>/<video> src, which can't attach a custom header.
// /proxy is hardened separately below by restricting which hosts it'll fetch.
// ---------------------------------------------------------------------------
app.use('/api/fal/*', async (c, next) => {
  const { backendKey } = resolveEnv(c);
  if (!backendKey) {
    return c.json({ error: 'This deployment has no BACKEND_KEY configured — set one before use.' }, 500);
  }
  if (c.req.header('x-fal-proxy-key') !== backendKey) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  return next();
});

/** The fal client keeps its credentials in module-level state; (re)configure
 * it at the top of every handler that calls it, since on Workers the key only
 * becomes available once a request arrives (there's no shared "boot" step). */
function configureFal(falKey: string | undefined): void {
  if (falKey) fal.config({ credentials: falKey });
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------
app.get('/healthz', (c) => {
  const { falKey, adminKey } = resolveEnv(c);
  return c.json({ ok: true, hasKey: Boolean(falKey), hasAdminKey: Boolean(adminKey) });
});

// Note: /embed/video, /embed/audio, /embed/3d, /embed/rig, /embed/panorama
// used to live here. They're now static pages shipped with the frontend
// (embed-video.html etc.) — verified live that none of them actually need a
// backend: video/audio/3d/rig play the Fal CDN URL directly, and even
// panorama's WebGL sky texture loads cross-origin cleanly (Fal's CDN sends
// Access-Control-Allow-Origin). See frontend/ARCHITECTURE.md.

// ---------------------------------------------------------------------------
// CORS proxy — streams a remote asset (a Fal .glb or .mp4) back with an
// Access-Control-Allow-Origin header. Used by the modal's capture-to-image
// tools:
//   • "3D Viewer → Image" loads a .glb into <model-viewer> and snapshots it;
//   • "Video Player → Image" loads a .mp4 into a <video crossorigin> and draws
//     the current frame to a canvas.
// The browser taints those canvases unless the asset was fetched
// cross-origin-clean, and Fal's CDN doesn't ship CORS headers — so both load
// through here. `Range` is forwarded (with the key headers mirrored back) so
// video seeking / scrubbing works.
//
// Built on fetch() + ReadableStream (not node:http/https) so it runs
// unchanged on Node, Cloudflare Workers, or any other fetch-based runtime.
//
// Unauthenticated by design (see the /api/fal/* auth middleware above) — it's
// only ever loaded via <img>/<video>/<iframe> src, none of which can attach
// the shared-secret header. Instead, the target host is restricted to Fal's
// own media CDN, so this can't be abused as a general-purpose open relay for
// arbitrary URLs; every real caller in this codebase only ever proxies a URL
// that a Fal generation just returned.
//
//   GET /proxy?url=<encoded url>
// ---------------------------------------------------------------------------
function isAllowedProxyHost(hostname: string): boolean {
  return hostname === 'fal.media' || hostname.endsWith('.fal.media');
}

app.get('/proxy', async (c) => {
  const target = c.req.query('url') ?? '';
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return c.json({ error: 'Missing or invalid url' }, 400);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return c.json({ error: 'Invalid scheme' }, 400);
  }
  if (!isAllowedProxyHost(parsed.hostname)) {
    return c.json({ error: `Host "${parsed.hostname}" is not allowed — only Fal's media CDN can be proxied.` }, 400);
  }

  const range = c.req.header('range');
  const upstreamHeaders: Record<string, string> = { 'User-Agent': 'fal-miro-proxy/1' };
  if (range) upstreamHeaders.Range = range;

  let upstream: Response;
  try {
    upstream = await fetch(target, { headers: upstreamHeaders });
  } catch (err) {
    console.error('[proxy] upstream error:', messageOf(err));
    return c.json({ error: messageOf(err) }, 502);
  }

  const headers = new Headers();
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges, Content-Type');
  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']) {
    const v = upstream.headers.get(h);
    if (v != null) headers.set(h, v);
  }

  // Return a raw Response (rather than c.body()) — upstream.status is a
  // runtime number, not one of Hono's compile-time status literals.
  return new Response(upstream.body, { status: upstream.status, headers });
});

// ---------------------------------------------------------------------------
// Run a model — submit to Fal's queue and return the request id immediately.
//
// Body: { endpointId: string, input: object }
//
// The decoupled architecture means the headless iframe polls /status; we never
// block the request thread waiting on a long generation.
// ---------------------------------------------------------------------------
app.post('/api/fal/run', bodyLimit({ maxSize: 50 * 1024 * 1024 }), async (c) => {
  const { falKey, debug } = resolveEnv(c);
  configureFal(falKey);
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: any = await c.req.json().catch(() => null);
    const endpointId = body?.endpointId;
    const input = body?.input;
    if (!endpointId || typeof endpointId !== 'string') {
      return c.json({ error: 'endpointId is required' }, 400);
    }
    if (!input || typeof input !== 'object') {
      return c.json({ error: 'input object is required' }, 400);
    }

    logBox(debug, `POST queue.submit → ${endpointId}`, summarizeInput(input));

    const { request_id: requestId } = await fal.queue.submit(endpointId, { input });

    if (debug) console.log(`[run] ${endpointId} request_id=${requestId}`);
    return c.json({ requestId, endpointId, status: 'QUEUED' });
  } catch (err) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const e = err as any;
    console.error('[run] error:', e?.status ?? '', e?.message ?? err);
    if (e?.body?.detail) console.error('[run] validation detail:', JSON.stringify(e.body.detail, null, 2));
    return c.json({ error: falError(err) }, 502);
  }
});

// ---------------------------------------------------------------------------
// Poll status. endpointId is required (Fal scopes requests to an endpoint).
// On completion we also fetch the result so the caller gets output URLs in one
// round trip.
//
//   GET /api/fal/status/:requestId?endpointId=fal-ai/flux/dev
// ---------------------------------------------------------------------------
app.get('/api/fal/status/:requestId', async (c) => {
  const { falKey, debug } = resolveEnv(c);
  configureFal(falKey);
  try {
    const requestId = c.req.param('requestId');
    const endpointId = c.req.query('endpointId');
    if (!endpointId) {
      return c.json({ error: 'endpointId query param is required' }, 400);
    }

    const status = await fal.queue.status(endpointId, { requestId, logs: false });
    const normalized = normalizeStatus(status.status);
    const queuePosition = 'queue_position' in status && typeof status.queue_position === 'number' ? status.queue_position : null;

    if (normalized !== 'SUCCEEDED') {
      return c.json({ requestId, endpointId, status: normalized, queuePosition });
    }

    // Completed — fetch the result payload.
    const result = await fal.queue.result(endpointId, { requestId });
    const data = result?.data ?? result ?? {};
    const output = extractOutputUrls(data);

    if (debug) console.log(`[status] ${endpointId} ${requestId} → SUCCEEDED (${output.length} output url(s))`);

    return c.json({ requestId, endpointId, status: 'SUCCEEDED', output, data });
  } catch (err) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const e = err as any;
    console.error('[status] error:', e?.status ?? '', e?.message ?? err);
    if (e?.body?.detail) console.error('[status] validation detail:', JSON.stringify(e.body.detail, null, 2));
    return c.json({ error: falError(err) }, 502);
  }
});

// ---------------------------------------------------------------------------
// Cancel an in-flight request.
//   POST /api/fal/cancel/:requestId?endpointId=...
// ---------------------------------------------------------------------------
app.post('/api/fal/cancel/:requestId', async (c) => {
  const { falKey } = resolveEnv(c);
  configureFal(falKey);
  try {
    const requestId = c.req.param('requestId');
    const endpointId = c.req.query('endpointId');
    if (!endpointId) {
      return c.json({ error: 'endpointId query param is required' }, 400);
    }
    await fal.queue.cancel(endpointId, { requestId });
    return c.json({ ok: true });
  } catch (err) {
    console.error('[cancel] error:', err);
    return c.json({ error: messageOf(err) }, 502);
  }
});

// ---------------------------------------------------------------------------
// Model schema — the heart of "Option A". Proxies Fal's Platform Models API
// with expand=openapi-3.0 so the frontend can build a form from the live
// schema instead of hardcoding fields per model.
//
//   GET /api/fal/schema?endpointId=fal-ai/flux/dev
//
// Returns { endpointId, metadata, openapi } where `openapi` is the model's
// full OpenAPI 3.0 spec (inputs, enums, ranges, output shape).
// ---------------------------------------------------------------------------
app.get('/api/fal/schema', async (c) => {
  const { falKey, falPlatformApiBase } = resolveEnv(c);
  try {
    const endpointId = c.req.query('endpointId');
    if (!endpointId) {
      return c.json({ error: 'endpointId query param is required' }, 400);
    }

    const url = new URL(`${falPlatformApiBase}/models`);
    url.searchParams.set('endpoint_id', endpointId);
    url.searchParams.set('expand', 'openapi-3.0');

    const headers: Record<string, string> = { Accept: 'application/json' };
    // Auth is optional but grants higher rate limits.
    if (falKey) headers.Authorization = `Key ${falKey}`;

    const upstream = await fetch(url, { headers });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const payload: any = await upstream.json();
    if (!upstream.ok) {
      return jsonResponse({ error: payload?.error?.message ?? `Models API ${upstream.status}` }, upstream.status);
    }

    const model = Array.isArray(payload.models) ? payload.models[0] : undefined;
    if (!model) {
      return c.json({ error: `No model found for endpoint_id "${endpointId}"` }, 404);
    }

    // `openapi` is either the spec or { error: {...} } if expansion failed.
    const openapi = model.openapi && !model.openapi.error ? model.openapi : null;
    if (!openapi) {
      return c.json(
        { error: model.openapi?.error?.message ?? 'OpenAPI expansion unavailable for this model' },
        502,
      );
    }

    return c.json({ endpointId: model.endpoint_id, metadata: model.metadata ?? null, openapi });
  } catch (err) {
    console.error('[schema] error:', err);
    return c.json({ error: messageOf(err) }, 502);
  }
});

// ---------------------------------------------------------------------------
// Model catalog sync — the discovery layer. Lists every Fal model with its
// metadata (category, tags, display_name, thumbnail, status) so the frontend
// can drive Category/tags and (eventually) auto-populate the catalog instead of
// hand-maintaining it. Paginated upstream; cached in-memory with a TTL to stay
// well under rate limits. Add ?refresh=1 to force a re-fetch.
//
// The cache is a plain module-level variable — the simplest thing that works.
// On Node it's shared by the whole (long-lived) process; on Cloudflare
// Workers it's shared only within a given isolate, so it resets more often
// there. That's a performance tradeoff, not a correctness one — left as-is
// for v1; revisit with a KV-backed cache only if Workers rate-limit or
// latency issues show up in practice.
//
//   GET /api/fal/models  → { models: [{ endpointId, displayName, category, tags[], status, thumbnailUrl }], count, cachedAt }
// ---------------------------------------------------------------------------
type ModelMeta = {
  endpointId: string;
  displayName: string | null;
  category: string | null;
  tags: string[];
  status: string | null;
  thumbnailUrl: string | null;
};

let modelsCache: { at: number; models: ModelMeta[] } | null = null;
const MODELS_TTL_MS = 60 * 60 * 1000;

app.get('/api/fal/models', async (c) => {
  const { falKey, adminKey, falPlatformApiBase } = resolveEnv(c);
  try {
    const refresh = c.req.query('refresh');
    const fresh = refresh === '1' || refresh === 'true';
    if (!fresh && modelsCache && Date.now() - modelsCache.at < MODELS_TTL_MS) {
      return c.json({ models: modelsCache.models, count: modelsCache.models.length, cachedAt: modelsCache.at });
    }

    const headers: Record<string, string> = { Accept: 'application/json' };
    const key = adminKey ?? falKey; // optional; a key grants higher rate limits
    if (key) headers.Authorization = `Key ${key}`;

    const all: ModelMeta[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 50; page++) {
      // Safety cap on pages.
      const url = new URL(`${falPlatformApiBase}/models`);
      url.searchParams.set('limit', '100');
      if (cursor) url.searchParams.set('cursor', cursor);

      const upstream = await fetch(url, { headers });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const payload: any = await upstream.json();
      if (!upstream.ok) {
        return jsonResponse({ error: payload?.error?.message ?? `Models ${upstream.status}` }, upstream.status);
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const models: any[] = Array.isArray(payload?.models) ? payload.models : [];
      for (const m of models) {
        const meta = m?.metadata ?? {};
        const endpointId = m?.endpoint_id ?? meta.endpoint_id ?? null;
        if (!endpointId) continue;
        all.push({
          endpointId,
          displayName: typeof meta.display_name === 'string' ? meta.display_name : null,
          category: typeof meta.category === 'string' ? meta.category : null,
          tags: Array.isArray(meta.tags) ? meta.tags.filter((t: unknown) => typeof t === 'string') : [],
          status: typeof meta.status === 'string' ? meta.status : null,
          thumbnailUrl: typeof meta.thumbnail_url === 'string' ? meta.thumbnail_url : null,
        });
      }

      if (!payload?.has_more || !payload?.next_cursor) break;
      cursor = payload.next_cursor;
    }

    modelsCache = { at: Date.now(), models: all };
    return c.json({ models: all, count: all.length, cachedAt: modelsCache.at });
  } catch (err) {
    console.error('[models] error:', err);
    return c.json({ error: messageOf(err) }, 502);
  }
});

// ---------------------------------------------------------------------------
// Account balance — powers the credits badge.
//   GET /api/fal/balance  → { balance, currency }
// Note: Fal's billing endpoint may require an Admin API key; if FAL_KEY lacks
// the scope this returns an error the badge renders as "—".
// ---------------------------------------------------------------------------
app.get('/api/fal/balance', async (c) => {
  const { adminKey, falPlatformApiBase } = resolveEnv(c);
  try {
    if (!adminKey) return c.json({ error: 'ADMIN_KEY not set' }, 400);
    const upstream = await fetch(`${falPlatformApiBase}/account/billing?expand=credits`, {
      headers: { Authorization: `Key ${adminKey}`, Accept: 'application/json' },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const payload: any = await upstream.json();
    if (!upstream.ok) {
      return jsonResponse({ error: payload?.error?.message ?? `Billing ${upstream.status}` }, upstream.status);
    }
    const credits = payload?.credits ?? null;
    return c.json({
      balance: typeof credits?.current_balance === 'number' ? credits.current_balance : null,
      currency: credits?.currency ?? 'USD',
    });
  } catch (err) {
    console.error('[balance] error:', err);
    return c.json({ error: messageOf(err) }, 502);
  }
});

// ---------------------------------------------------------------------------
// Cost estimate — unit price × billing units. Best-effort (no per-call cost is
// returned by Fal), used to stamp an est. cost on each generated asset.
//   GET /api/fal/estimate?endpointId=…&units=N  → { costUSD, unit }
// ---------------------------------------------------------------------------
app.get('/api/fal/estimate', async (c) => {
  const { falKey, adminKey, falPlatformApiBase } = resolveEnv(c);
  try {
    const endpointId = c.req.query('endpointId');
    const units = Math.max(1, Number(c.req.query('units')) || 1);
    // Elapsed compute time (seconds), supplied for time-billed models.
    const secondsRaw = Number(c.req.query('seconds'));
    const seconds = secondsRaw > 0 ? secondsRaw : null;
    if (!endpointId) {
      return c.json({ error: 'endpointId query param is required' }, 400);
    }
    const url = new URL(`${falPlatformApiBase}/models/pricing`);
    url.searchParams.set('endpoint_id', endpointId);
    const headers: Record<string, string> = { Accept: 'application/json' };
    const pricingKey = adminKey ?? falKey;
    if (pricingKey) headers.Authorization = `Key ${pricingKey}`;
    const upstream = await fetch(url, { headers });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const payload: any = await upstream.json();
    if (!upstream.ok) {
      return jsonResponse({ error: payload?.error?.message ?? `Pricing ${upstream.status}` }, upstream.status);
    }
    const price = Array.isArray(payload?.prices) ? payload.prices[0] : null;
    if (!price || typeof price.unit_price !== 'number') {
      return c.json({ costUSD: null, unit: price?.unit ?? null });
    }
    // Time-billed models (Fal reports a unit like "second" / "compute_second")
    // are charged by how long the job runs, not by output count — so multiply
    // by the elapsed seconds when the caller provides them. Everything else
    // (per image / per megapixel / per video) bills by `units`.
    const unit = typeof price.unit === 'string' ? price.unit : null;
    const perSecond = unit ? /second/i.test(unit) : false;
    const billedUnits = perSecond && seconds ? seconds : units;
    return c.json({
      costUSD: Number((price.unit_price * billedUnits).toFixed(4)),
      unit,
      unitPrice: price.unit_price,
      units: billedUnits,
      perSecond,
    });
  } catch (err) {
    console.error('[estimate] error:', err);
    return c.json({ error: messageOf(err) }, 502);
  }
});
