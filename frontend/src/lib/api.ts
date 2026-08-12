// Thin client for the fal-miro backend. The frontend never talks to Fal
// directly — the FAL_KEY lives only on the backend.
//
// The backend's URL + shared secret are runtime-configurable (not baked in at
// build time), set via configureBackend() — see shared/backendConfig.ts,
// which loads them from board appData (the Settings screen) once at each
// iframe's startup. This is what lets one shared, publicly-hosted frontend
// build point at whichever backend a given board's owner deployed, with their
// own FAL_KEY. VITE_API_BASE_URL / VITE_BACKEND_KEY are a fallback for local
// dev convenience only — never used as a default in the public build (there's
// no .env in that build), so an unconfigured board fails closed rather than
// silently spending someone else's Fal credits.

export type BackendConfig = { url: string; key: string };

let runtimeConfig: BackendConfig | null = null;

/** Called once per iframe at startup (see shared/backendConfig.ts). */
export function configureBackend(cfg: BackendConfig | null): void {
  runtimeConfig = cfg && cfg.url && cfg.key ? cfg : null;
}

function backendUrl(): string {
  return runtimeConfig?.url || import.meta.env.VITE_API_BASE_URL || '';
}

function backendKey(): string {
  return runtimeConfig?.key || import.meta.env.VITE_BACKEND_KEY || '';
}

export function isBackendConfigured(): boolean {
  return Boolean(backendUrl() && backendKey());
}

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

export const api = {
  /** Submit a model run to Fal's queue. Returns immediately with a requestId. */
  run: (body: RunRequest) =>
    request<RunResponse>('/api/fal/run', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /** Poll a request. On SUCCEEDED the response also carries output + data. */
  getStatus: (endpointId: string, requestId: string) =>
    request<StatusResponse>(
      `/api/fal/status/${requestId}?endpointId=${encodeURIComponent(endpointId)}`,
    ),

  /** Cancel an in-flight request. */
  cancel: (endpointId: string, requestId: string) =>
    request<{ ok: true }>(
      `/api/fal/cancel/${requestId}?endpointId=${encodeURIComponent(endpointId)}`,
      { method: 'POST' },
    ),

  /** Fetch a model's OpenAPI 3.0 schema (drives the generic form). */
  getSchema: (endpointId: string) =>
    request<SchemaResponse>(`/api/fal/schema?endpointId=${encodeURIComponent(endpointId)}`),

  /** Discovery: every Fal model + its metadata (category, tags, thumbnail…). */
  getModels: () =>
    request<{ models: FalModelMeta[]; count: number; cachedAt: number }>('/api/fal/models'),

  /** Account credit balance (powers the credits badge). */
  getBalance: () => request<{ balance: number | null; currency: string }>('/api/fal/balance'),

  /**
   * Best-effort cost estimate: unit price × billing units. For time-billed
   * models (unit contains "second"), pass `seconds` (elapsed compute time) and
   * the backend bills on that instead of `units`.
   */
  estimate: (endpointId: string, units: number, seconds?: number) =>
    request<{
      costUSD: number | null;
      unit: string | null;
      unitPrice?: number;
      units?: number;
      perSecond?: boolean;
    }>(
      `/api/fal/estimate?endpointId=${encodeURIComponent(endpointId)}&units=${units}` +
        (seconds && seconds > 0 ? `&seconds=${seconds}` : ''),
    ),

  /**
   * Read a Doc-format item's text content — the one thing the Web SDK can't
   * do, so it goes through the backend's Miro OAuth token instead of a
   * regular Fal-proxy call. 401s with a clear message if `userId` (from
   * `miro.board.getUserInfo()`) hasn't connected a Miro account yet.
   */
  getDocumentContent: (boardId: string, itemId: string, userId: string) =>
    request<{ content: string; contentVersion: number | null }>(
      `/api/miro/documents/${encodeURIComponent(itemId)}?boardId=${encodeURIComponent(boardId)}&userId=${encodeURIComponent(userId)}`,
    ),

  /** Whether `userId` currently has a Miro account connected (Settings status indicator). */
  getMiroStatus: (userId: string) =>
    request<{ connected: boolean }>(`/api/miro/status?userId=${encodeURIComponent(userId)}`),
};

/**
 * URL that starts the Miro OAuth flow for `userId` — open in a new tab
 * (`window.open`), not this iframe; Miro's authorize screen refuses to render
 * inside one. No in-app callback handling needed: the backend's
 * /oauth/callback just shows a plain "connected, close this tab" page.
 */
export function miroConnectUrl(userId: string): string {
  return `${backendUrl()}/oauth/start?userId=${encodeURIComponent(userId)}`;
}

// Embed pages ship as static files with the frontend itself (embed-video.html
// etc, at the project root) — not the backend. None of them need a backend at
// all: video/audio/3d/rig play the Fal CDN URL directly, and panorama's
// <a-sky> texture load works cross-origin too (Fal's CDN sends
// Access-Control-Allow-Origin — verified live against a real generation).
// That makes these genuinely generic: they render the same regardless of
// which backend (if any) a given board is using. `import.meta.env.BASE_URL`
// picks up whatever `base` is configured in vite.config.ts, so this resolves
// correctly even when the frontend is hosted under a subpath (e.g. a GitHub
// Pages project site).
function frontendPageUrl(page: string): string {
  return `${window.location.origin}${import.meta.env.BASE_URL}${page}`;
}

/** URL to the static page that wraps a Fal video URL in an iframable player. */
export function videoEmbedUrl(videoUrl: string): string {
  return `${frontendPageUrl('embed-video.html')}?url=${encodeURIComponent(videoUrl)}`;
}

/** URL to the static page that renders a Fal .glb in an orbit-able viewer. */
export function model3dEmbedUrl(glbUrl: string): string {
  return `${frontendPageUrl('embed-3d.html')}?url=${encodeURIComponent(glbUrl)}`;
}

/** URL to the static page that plays a Fal audio URL in an <audio> player. */
export function audioEmbedUrl(audioUrl: string): string {
  return `${frontendPageUrl('embed-audio.html')}?url=${encodeURIComponent(audioUrl)}`;
}

/** URL to the static page that renders an equirectangular image as a 360° photosphere. */
export function panoramaEmbedUrl(imageUrl: string): string {
  return `${frontendPageUrl('embed-panorama.html')}?url=${encodeURIComponent(imageUrl)}`;
}

/** URL to the static page that plays a rigged/animated .glb character. */
export function rigEmbedUrl(glbUrl: string): string {
  return `${frontendPageUrl('embed-rig.html')}?url=${encodeURIComponent(glbUrl)}`;
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
