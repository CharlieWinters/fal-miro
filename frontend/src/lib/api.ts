// Thin client for talking to Fal, in one of two connection modes:
//
//   'backend' — the frontend never talks to Fal directly; FAL_KEY lives only
//     on a backend the board owner deployed, and every call here proxies
//     through it (see shared/backendConfig.ts). Full feature set.
//   'client'  — the browser talks to Fal directly with a Fal API key stored
//     in this browser's localStorage, using @fal-ai/client. Nothing to
//     deploy, but the key is only as private as this browser (Fal's own
//     docs recommend the backend-proxy pattern for anything beyond
//     prototyping) — and a few backend-only things (credit balance, Miro Doc
//     reading) simply aren't available in this mode.
//
// Mode + credentials are runtime-configurable (not baked in at build time),
// set via configureConnection() once per iframe at startup. VITE_API_BASE_URL
// / VITE_BACKEND_KEY are a fallback for local dev convenience only — never
// used as a default in the public build, so an unconfigured board fails
// closed rather than silently spending someone else's Fal credits.
import { fal } from '@fal-ai/client';
import { extractOutputUrls, normalizeStatus } from '../shared/falOutput';
import { describeFalError, hasModelDetail, httpStatusOf, terminalStatusFor } from '../shared/falError';

export type ConnectionConfig =
  | { mode: 'backend'; url: string; key: string }
  | { mode: 'client'; falKey: string };

let runtimeConfig: ConnectionConfig | null = null;

/** Called once per iframe at startup (see shared/backendConfig.ts). */
export function configureConnection(cfg: ConnectionConfig | null): void {
  const valid: ConnectionConfig | null =
    cfg?.mode === 'backend' && cfg.url && cfg.key
      ? cfg
      : cfg?.mode === 'client' && cfg.falKey
        ? cfg
        : null;
  runtimeConfig = valid;
  if (valid?.mode === 'client') fal.config({ credentials: valid.falKey });
}

export function connectionMode(): 'backend' | 'client' | null {
  return runtimeConfig?.mode ?? null;
}

export function isConnectionConfigured(): boolean {
  return runtimeConfig !== null;
}

function backendUrl(): string {
  return (runtimeConfig?.mode === 'backend' ? runtimeConfig.url : '') || import.meta.env.VITE_API_BASE_URL || '';
}

function backendKey(): string {
  return (runtimeConfig?.mode === 'backend' ? runtimeConfig.key : '') || import.meta.env.VITE_BACKEND_KEY || '';
}

function falKey(): string {
  return runtimeConfig?.mode === 'client' ? runtimeConfig.falKey : '';
}

// Fal's Platform Models API — same base the backend proxies (see
// backend/src/lib/env.ts's FAL_PLATFORM_API_BASE); hardcoded here since
// client mode has no backend to source it from.
const FAL_PLATFORM_API_BASE = 'https://api.fal.ai/v1';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const base = backendUrl();
  const key = backendKey();
  if (!base || !key) {
    throw new Error('Backend not configured — set your backend URL and key in Settings.');
  }
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'x-fal-proxy-key': key,
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new Error(
      typeof data?.error === 'string' ? data.error : `${res.status} ${res.statusText}`,
    );
  }
  return data as T;
}

/** A direct, unauthenticated-fallback GET against Fal's Platform API — used
 *  by client mode's schema/models/pricing lookups, which have no backend to
 *  proxy through. Includes the Fal key for higher rate limits, same as the
 *  backend already does for these same endpoints. */
async function clientFetchJson<T>(url: string): Promise<T> {
  const key = falKey();
  const res = await fetch(url, { headers: key ? { Authorization: `Key ${key}` } : {} });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new Error(
      typeof data?.error?.message === 'string' ? data.error.message : `${res.status} ${res.statusText}`,
    );
  }
  return data as T;
}

export type RunRequest = {
  endpointId: string;
  /** Model-specific arguments, built by the panel form from the schema. */
  input: Record<string, unknown>;
};

export type RunResponse = {
  requestId: string;
  endpointId: string;
  status: 'QUEUED';
};

export type FalStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN';

export type StatusResponse = {
  requestId: string;
  endpointId: string;
  status: FalStatus;
  queuePosition?: number | null;
  /** Why Fal rejected or abandoned the request (present on FAILED). */
  error?: string;
  /** Best-effort primary output media URLs (present on SUCCEEDED). */
  output?: string[];
  /** Full untouched Fal result payload (present on SUCCEEDED). */
  data?: Record<string, unknown>;
};

/** A model's live OpenAPI schema, used to build the input form (Option A). */
export type SchemaResponse = {
  endpointId: string;
  metadata: Record<string, unknown> | null;
  openapi: Record<string, unknown>;
};

/** Normalized per-endpoint metadata from fal's Models API (discovery layer). */
export type FalModelMeta = {
  endpointId: string;
  displayName: string | null;
  category: string | null;
  tags: string[];
  status: string | null;
  thumbnailUrl: string | null;
};

// --- client-mode implementations: same contract as the backend routes
// above, but talking to Fal directly via @fal-ai/client / its Platform API. ---

async function clientRun(body: RunRequest): Promise<RunResponse> {
  const { request_id } = await fal.queue.submit(body.endpointId, { input: body.input });
  return { requestId: request_id, endpointId: body.endpointId, status: 'QUEUED' };
}

async function clientGetStatus(endpointId: string, requestId: string): Promise<StatusResponse> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let status: any;
  try {
    status = await fal.queue.status(endpointId, { requestId, logs: false });
  } catch (err) {
    // Fal reports a request that failed *on its side* — bad inputs, no media
    // generated, a safety block — as a 4xx on the status call. That is a
    // terminal answer about the job, not a problem reaching Fal, so it has to
    // come back as a status the poller can finish on. Thrown, it is counted as
    // a transport error, retried five times, and reported as PollUnreachable,
    // which every caller deliberately leaves for resume_jobs to collect later
    // — leaving a placeholder that says "generating" and a panel that says
    // "resuming" for a job that can never come back, with the reason Fal sent
    // in full on the very first poll never shown.
    //
    // The backend route already does exactly this (terminalStatusFor in
    // backend/src/app.ts). Client mode had no equivalent, so this was the only
    // path where a permanent rejection looked like a flaky network.
    const terminal = terminalStatusFor(httpStatusOf(err), hasModelDetail(err));
    if (!terminal) throw err;
    return { requestId, endpointId, status: terminal, error: describeFalError(err) };
  }
  const normalized = normalizeStatus(status?.status);
  const queuePosition = typeof status?.queue_position === 'number' ? status.queue_position : null;
  if (normalized !== 'SUCCEEDED') {
    return { requestId, endpointId, status: normalized, queuePosition };
  }
  // The result call rejects the same way the status call does, and this is
  // where `no_media_generated` arrives — the job ran, produced nothing usable,
  // and Fal says so with a 4xx. Terminal, not transient.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let result: any;
  try {
    result = await fal.queue.result(endpointId, { requestId });
  } catch (err) {
    const terminal = terminalStatusFor(httpStatusOf(err), hasModelDetail(err));
    if (!terminal) throw err;
    return { requestId, endpointId, status: terminal, error: describeFalError(err) };
  }
  const data = result?.data ?? result ?? {};
  return { requestId, endpointId, status: 'SUCCEEDED', output: extractOutputUrls(data), data };
}

async function clientCancel(endpointId: string, requestId: string): Promise<{ ok: true }> {
  await fal.queue.cancel(endpointId, { requestId });
  return { ok: true };
}

async function clientGetSchema(endpointId: string): Promise<SchemaResponse> {
  const url = `${FAL_PLATFORM_API_BASE}/models?endpoint_id=${encodeURIComponent(endpointId)}&expand=openapi-3.0`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const payload: any = await clientFetchJson(url);
  const model = Array.isArray(payload.models) ? payload.models[0] : undefined;
  if (!model) throw new Error(`No model found for endpoint_id "${endpointId}"`);
  const openapi = model.openapi && !model.openapi.error ? model.openapi : null;
  if (!openapi) throw new Error(model.openapi?.error?.message ?? 'OpenAPI expansion unavailable for this model');
  return { endpointId: model.endpoint_id, metadata: model.metadata ?? null, openapi };
}

async function clientGetModels(): Promise<{ models: FalModelMeta[]; count: number; cachedAt: number }> {
  const all: FalModelMeta[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 50; page++) {
    const url = new URL(`${FAL_PLATFORM_API_BASE}/models`);
    url.searchParams.set('limit', '100');
    if (cursor) url.searchParams.set('cursor', cursor);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const payload: any = await clientFetchJson(url.toString());
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
  return { models: all, count: all.length, cachedAt: Date.now() };
}

async function clientEstimate(
  endpointId: string,
  units: number,
  seconds?: number,
): Promise<{ costUSD: number | null; unit: string | null; unitPrice?: number; units?: number; perSecond?: boolean }> {
  const url = `${FAL_PLATFORM_API_BASE}/models/pricing?endpoint_id=${encodeURIComponent(endpointId)}`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const payload: any = await clientFetchJson(url);
  const price = Array.isArray(payload?.prices) ? payload.prices[0] : null;
  if (!price || typeof price.unit_price !== 'number') return { costUSD: null, unit: price?.unit ?? null };
  const unit = typeof price.unit === 'string' ? price.unit : null;
  const perSecond = unit ? /second/i.test(unit) : false;
  const billedUnits = perSecond && seconds ? seconds : units;
  return {
    costUSD: Number((price.unit_price * billedUnits).toFixed(4)),
    unit,
    unitPrice: price.unit_price,
    units: billedUnits,
    perSecond,
  };
}

const isClient = () => connectionMode() === 'client';

export const api = {
  /** Submit a model run to Fal's queue. Returns immediately with a requestId. */
  run: (body: RunRequest) =>
    isClient()
      ? clientRun(body)
      : request<RunResponse>('/api/fal/run', { method: 'POST', body: JSON.stringify(body) }),

  /** Poll a request. On SUCCEEDED the response also carries output + data. */
  getStatus: (endpointId: string, requestId: string) =>
    isClient()
      ? clientGetStatus(endpointId, requestId)
      : request<StatusResponse>(`/api/fal/status/${requestId}?endpointId=${encodeURIComponent(endpointId)}`),

  /** Cancel an in-flight request. */
  cancel: (endpointId: string, requestId: string) =>
    isClient()
      ? clientCancel(endpointId, requestId)
      : request<{ ok: true }>(
          `/api/fal/cancel/${requestId}?endpointId=${encodeURIComponent(endpointId)}`,
          { method: 'POST' },
        ),

  /** Fetch a model's OpenAPI 3.0 schema (drives the generic form). */
  getSchema: (endpointId: string) =>
    isClient()
      ? clientGetSchema(endpointId)
      : request<SchemaResponse>(`/api/fal/schema?endpointId=${encodeURIComponent(endpointId)}`),

  /** Discovery: every Fal model + its metadata (category, tags, thumbnail…). */
  getModels: () =>
    isClient()
      ? clientGetModels()
      : request<{ models: FalModelMeta[]; count: number; cachedAt: number }>('/api/fal/models'),

  /** Account credit balance (powers the credits badge) — backend-only: needs
   *  ADMIN_KEY, a more sensitive key than the one client mode already holds. */
  getBalance: (): Promise<{ balance: number | null; currency: string }> =>
    isClient()
      ? Promise.reject(new Error('Credit balance requires backend mode.'))
      : request('/api/fal/balance'),

  /**
   * Best-effort cost estimate: unit price × billing units. For time-billed
   * models (unit contains "second"), pass `seconds` (elapsed compute time) and
   * the backend bills on that instead of `units`.
   */
  estimate: (endpointId: string, units: number, seconds?: number) =>
    isClient()
      ? clientEstimate(endpointId, units, seconds)
      : request<{
          costUSD: number | null;
          unit: string | null;
          unitPrice?: number;
          units?: number;
          perSecond?: boolean;
        }>(
          `/api/fal/estimate?endpointId=${encodeURIComponent(endpointId)}&units=${units}` +
            (seconds && seconds > 0 ? `&seconds=${seconds}` : ''),
        ),

};

// Embed pages ship as static files with the frontend itself (embed-video.html
// etc, at the project root) — not the backend. None of them need a backend at
// all: video/audio/3d/rig play the Fal CDN URL directly, panorama's <a-sky>
// texture load works cross-origin too, and embed-motion.html's FBXLoader
// fetches the clip the same way (Fal's CDN sends Access-Control-Allow-Origin
// — verified live against real generations).
// That makes these genuinely generic: they render the same regardless of
// which backend (if any) a given board is using. `import.meta.env.BASE_URL`
// picks up whatever `base` is configured in vite.config.ts, so this resolves
// correctly even when the frontend is hosted under a subpath (e.g. a GitHub
// Pages project site).
function frontendPageUrl(page: string): string {
  return `${window.location.origin}${import.meta.env.BASE_URL}${page}`;
}

/**
 * Build one of our embed-page URLs, with a one-shot cache-buster.
 *
 * Miro resolves an embed URL once and caches the outcome against that exact
 * URL. If the first resolution fails — a timeout, a cold start, a blip — the
 * *failure* is what sticks: the board shows a grey placeholder instead of the
 * viewer, with no error, nothing to click and no way to retry. Re-creating the
 * item at the same URL changes nothing, because Miro never asks again.
 *
 * Seen live on 8 Sep 2026: two embed-rig.html embeds stuck on the placeholder
 * while an embed-3d.html on the same origin rendered fine. Identical `mode`
 * and options; the only difference was which URLs Miro had already resolved.
 * Re-creating them with a fresh `cb` made both render immediately.
 *
 * So every embed we create carries a value Miro has never seen, which costs
 * nothing and removes the failure mode. The unwrap* helpers below read `url`
 * through `searchParams`, so the extra parameter is invisible to them.
 */
function embedPageUrl(page: string, assetUrl: string): string {
  const cb = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  return `${frontendPageUrl(page)}?url=${encodeURIComponent(assetUrl)}&cb=${cb}`;
}

/** URL to the static page that wraps a Fal video URL in an iframable player. */
export function videoEmbedUrl(videoUrl: string): string {
  return embedPageUrl('embed-video.html', videoUrl);
}

/** URL to the static page that renders a Fal .glb in an orbit-able viewer. */
export function model3dEmbedUrl(glbUrl: string): string {
  return embedPageUrl('embed-3d.html', glbUrl);
}

/** URL to the static page that plays a Fal audio URL in an <audio> player. */
export function audioEmbedUrl(audioUrl: string): string {
  return embedPageUrl('embed-audio.html', audioUrl);
}

/** URL to the static page that renders an equirectangular image as a 360° photosphere. */
export function panoramaEmbedUrl(imageUrl: string): string {
  return embedPageUrl('embed-panorama.html', imageUrl);
}

/** URL to the static page that plays a rigged/animated .glb character. */
export function rigEmbedUrl(glbUrl: string): string {
  return embedPageUrl('embed-rig.html', glbUrl);
}

/**
 * URL to the static page that plays a Hunyuan Motion .fbx clip on a grid —
 * on the mannequin it ships with, or retargeted onto a rigged character
 * (`characterUrl`: a glb with a Mixamo-style skeleton, e.g. a Meshy rig).
 */
export function motionEmbedUrl(fbxUrl: string, characterUrl?: string | null): string {
  const base = embedPageUrl('embed-motion.html', fbxUrl);
  return characterUrl ? `${base}&character=${encodeURIComponent(characterUrl)}` : base;
}

/**
 * Backend CORS proxy for an asset — used by the modal's capture-to-image
 * tools to snapshot a canvas cleanly. Unlike the embed pages above, this
 * really does need a live backend (only the person using a capture tool
 * needs it, not every board viewer, so that's an acceptable dependency).
 */
export function proxyUrl(assetUrl: string): string {
  return `${backendUrl()}/proxy?url=${encodeURIComponent(assetUrl)}`;
}

/** Extract the underlying .glb URL from one of our embed-3d.html URLs. */
export function unwrapModel3dEmbedUrl(embedUrl: string): string | null {
  try {
    const u = new URL(embedUrl, window.location.origin);
    if (!u.pathname.endsWith('/embed-3d.html')) return null;
    return u.searchParams.get('url');
  } catch {
    return null;
  }
}

/** Extract the underlying video URL from one of our embed-video.html URLs. */
export function unwrapVideoEmbedUrl(embedUrl: string): string | null {
  try {
    const u = new URL(embedUrl, window.location.origin);
    if (!u.pathname.endsWith('/embed-video.html')) return null;
    return u.searchParams.get('url');
  } catch {
    return null;
  }
}

/** Extract the underlying audio URL from one of our embed-audio.html URLs. */
export function unwrapAudioEmbedUrl(embedUrl: string): string | null {
  try {
    const u = new URL(embedUrl, window.location.origin);
    if (!u.pathname.endsWith('/embed-audio.html')) return null;
    return u.searchParams.get('url');
  } catch {
    return null;
  }
}

/** Extract the underlying equirectangular image URL from an embed-panorama.html URL. */
export function unwrapPanoramaEmbedUrl(embedUrl: string): string | null {
  try {
    const u = new URL(embedUrl, window.location.origin);
    if (!u.pathname.endsWith('/embed-panorama.html')) return null;
    return u.searchParams.get('url');
  } catch {
    return null;
  }
}

/** The character glb a motion embed plays on, or null for the mannequin. */
export function unwrapMotionCharacterUrl(embedUrl: string): string | null {
  try {
    const u = new URL(embedUrl, window.location.origin);
    if (!u.pathname.endsWith('/embed-motion.html')) return null;
    return u.searchParams.get('character');
  } catch {
    return null;
  }
}

/** Extract the underlying .fbx URL from an embed-motion.html URL. */
export function unwrapMotionEmbedUrl(embedUrl: string): string | null {
  try {
    const u = new URL(embedUrl, window.location.origin);
    if (!u.pathname.endsWith('/embed-motion.html')) return null;
    return u.searchParams.get('url');
  } catch {
    return null;
  }
}

/** Extract the underlying animated .glb URL from an embed-rig.html URL. */
export function unwrapRigEmbedUrl(embedUrl: string): string | null {
  try {
    const u = new URL(embedUrl, window.location.origin);
    if (!u.pathname.endsWith('/embed-rig.html')) return null;
    return u.searchParams.get('url');
  } catch {
    return null;
  }
}
