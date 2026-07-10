// Thin client for the fal-miro backend. The frontend never talks to Fal
// directly — the FAL_KEY lives only on the backend.

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  if (!API_BASE_URL) {
    throw new Error('VITE_API_BASE_URL is not set — add it to .env');
  }
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
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
};

/** URL to the backend page that wraps a Fal video URL in an iframable player. */
export function videoEmbedUrl(videoUrl: string): string {
  return `${API_BASE_URL}/embed/video?url=${encodeURIComponent(videoUrl)}`;
}

/** URL to the backend page that renders a Fal .glb in an orbit-able viewer. */
export function model3dEmbedUrl(glbUrl: string): string {
  return `${API_BASE_URL}/embed/3d?url=${encodeURIComponent(glbUrl)}`;
}

/** URL to the backend page that plays a Fal audio URL in an <audio> player. */
export function audioEmbedUrl(audioUrl: string): string {
  return `${API_BASE_URL}/embed/audio?url=${encodeURIComponent(audioUrl)}`;
}

/** URL to the backend page that renders an equirectangular image as a 360° photosphere. */
export function panoramaEmbedUrl(imageUrl: string): string {
  return `${API_BASE_URL}/embed/panorama?url=${encodeURIComponent(imageUrl)}`;
}

/** URL to the backend page that plays a rigged/animated .glb character. */
export function rigEmbedUrl(glbUrl: string): string {
  return `${API_BASE_URL}/embed/rig?url=${encodeURIComponent(glbUrl)}`;
}

/** Backend CORS proxy for an asset — used to snapshot a .glb canvas cleanly. */
export function proxyUrl(assetUrl: string): string {
  return `${API_BASE_URL}/proxy?url=${encodeURIComponent(assetUrl)}`;
}

/** Extract the underlying .glb URL from one of our /embed/3d embed URLs. */
export function unwrapModel3dEmbedUrl(embedUrl: string): string | null {
  try {
    const u = new URL(embedUrl, API_BASE_URL || window.location.origin);
    if (!u.pathname.endsWith('/embed/3d')) return null;
    return u.searchParams.get('url');
  } catch {
    return null;
  }
}

/** Extract the underlying video URL from one of our /embed/video embed URLs. */
export function unwrapVideoEmbedUrl(embedUrl: string): string | null {
  try {
    const u = new URL(embedUrl, API_BASE_URL || window.location.origin);
    if (!u.pathname.endsWith('/embed/video')) return null;
    return u.searchParams.get('url');
  } catch {
    return null;
  }
}

/** Extract the underlying audio URL from one of our /embed/audio embed URLs. */
export function unwrapAudioEmbedUrl(embedUrl: string): string | null {
  try {
    const u = new URL(embedUrl, API_BASE_URL || window.location.origin);
    if (!u.pathname.endsWith('/embed/audio')) return null;
    return u.searchParams.get('url');
  } catch {
    return null;
  }
}

/** Extract the underlying equirectangular image URL from a /embed/panorama URL. */
export function unwrapPanoramaEmbedUrl(embedUrl: string): string | null {
  try {
    const u = new URL(embedUrl, API_BASE_URL || window.location.origin);
    if (!u.pathname.endsWith('/embed/panorama')) return null;
    return u.searchParams.get('url');
  } catch {
    return null;
  }
}

/** Extract the underlying animated .glb URL from a /embed/rig URL. */
export function unwrapRigEmbedUrl(embedUrl: string): string | null {
  try {
    const u = new URL(embedUrl, API_BASE_URL || window.location.origin);
    if (!u.pathname.endsWith('/embed/rig')) return null;
    return u.searchParams.get('url');
  } catch {
    return null;
  }
}

export { API_BASE_URL };
