import { beforeEach, describe, expect, it, vi } from 'vitest';

// The fal client is module-level state; stub the pieces the routes touch.
const queue = vi.hoisted(() => ({
  submit: vi.fn(),
  status: vi.fn(),
  result: vi.fn(),
  cancel: vi.fn(),
}));
vi.mock('@fal-ai/client', () => ({ fal: { config: vi.fn(), queue } }));

import { app, constantTimeEqual, isProxyableContentType, terminalStatusFor } from './app.js';

// hono/adapter's env() reads process.env on Node, so that is where the test
// config has to live (the third argument to app.request is only read on
// Workers-style runtimes).
const env = { FAL_KEY: 'test-fal', BACKEND_KEY: 'shared-secret', ALLOWED_ORIGINS: 'https://panel.example' };
const authed = { 'x-fal-proxy-key': 'shared-secret' };
function setEnv(overrides: Partial<typeof env> = {}) {
  Object.assign(process.env, { ...env, ...overrides });
}

function falError(status: number, detail?: unknown) {
  const e = new Error(`HTTP ${status}`) as Error & { status: number; body?: unknown };
  e.status = status;
  if (detail !== undefined) e.body = { detail };
  return e;
}

beforeEach(() => {
  vi.clearAllMocks();
  setEnv();
});

describe('auth on /api/fal/*', () => {
  it('rejects a missing key with 401 and never touches Fal', async () => {
    const res = await app.request('/api/fal/status/r1?endpointId=fal-ai/x');
    expect(res.status).toBe(401);
    expect(queue.status).not.toHaveBeenCalled();
  });

  it('rejects a wrong key', async () => {
    const res = await app.request('/api/fal/status/r1?endpointId=fal-ai/x', { headers: { 'x-fal-proxy-key': 'nope' } });
    expect(res.status).toBe(401);
  });

  it('fails closed when the deployment has no BACKEND_KEY', async () => {
    setEnv({ BACKEND_KEY: '' });
    const res = await app.request('/api/fal/status/r1?endpointId=fal-ai/x', { headers: authed });
    expect(res.status).toBe(500);
  });
});

describe('GET /api/fal/status', () => {
  it('passes a running status through', async () => {
    queue.status.mockResolvedValue({ status: 'IN_PROGRESS' });
    const res = await app.request('/api/fal/status/r1?endpointId=fal-ai/x', { headers: authed });
    expect(res.status).toBe(200);
    expect((await res.json()) as object).toMatchObject({ status: 'RUNNING', requestId: 'r1' });
  });

  it('returns output URLs on completion', async () => {
    queue.status.mockResolvedValue({ status: 'COMPLETED' });
    queue.result.mockResolvedValue({ data: { images: [{ url: 'https://v3.fal.media/a.jpg' }] } });
    const res = await app.request('/api/fal/status/r1?endpointId=fal-ai/x', { headers: authed });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('SUCCEEDED');
    expect(body.output).toEqual(['https://v3.fal.media/a.jpg']);
  });

  it('reports a Fal-side rejection as a terminal FAILED status, not a 502', async () => {
    queue.status.mockResolvedValue({ status: 'COMPLETED' });
    queue.result.mockRejectedValue(falError(422, [{ type: 'no_media_generated', msg: 'nothing', loc: ['body'] }]));
    const res = await app.request('/api/fal/status/r1?endpointId=fal-ai/x', { headers: authed });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('FAILED');
    expect(body.requestId).toBe('r1');
    expect(String(body.error)).toMatch(/no output|no_media_generated/);
  });

  it('reports an unknown request id as terminal UNKNOWN', async () => {
    queue.status.mockRejectedValue(falError(404));
    const res = await app.request('/api/fal/status/gone?endpointId=fal-ai/x', { headers: authed });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('UNKNOWN');
  });

  it('keeps transient upstream trouble as a 502 so pollers retry', async () => {
    queue.status.mockRejectedValue(falError(503));
    const res = await app.request('/api/fal/status/r1?endpointId=fal-ai/x', { headers: authed });
    expect(res.status).toBe(502);
  });

  it('reports a model refusal as FAILED even when Fal answers 500', async () => {
    // Bria's ad-delayer refuses an oversized image this way. Read as transient,
    // it had the caller retrying on every board load forever.
    queue.status.mockResolvedValue({ status: 'COMPLETED' });
    queue.result.mockRejectedValue(
      falError(500, 'Image exceeds 800 px per dimension on this endpoint. Resize the source image.'),
    );
    const res = await app.request('/api/fal/status/r1?endpointId=fal-ai/x', { headers: authed });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('FAILED');
    expect(String(body.error)).toMatch(/800 px/);
  });

  it('classifies HTTP statuses', () => {
    expect(terminalStatusFor(422)).toBe('FAILED');
    expect(terminalStatusFor(400)).toBe('FAILED');
    expect(terminalStatusFor(404)).toBe('UNKNOWN');
    expect(terminalStatusFor(429)).toBeNull();
    expect(terminalStatusFor(500)).toBeNull();
    expect(terminalStatusFor(undefined)).toBeNull();
  });

  it('treats any model-level detail as terminal, except when the fault is ours', () => {
    // A `detail` body means Fal reached the model and the model refused.
    expect(terminalStatusFor(500, true)).toBe('FAILED');
    expect(terminalStatusFor(424, true)).toBe('FAILED');
    expect(terminalStatusFor(503, true)).toBe('FAILED');
    // Our key or our pacing — says nothing about the job, so keep retrying.
    for (const s of [401, 403, 408, 429]) expect(terminalStatusFor(s, true), String(s)).toBeNull();
    // No detail: an unexplained 5xx is still just upstream trouble.
    expect(terminalStatusFor(503, false)).toBeNull();
    expect(terminalStatusFor(undefined, true)).toBeNull();
  });
});

describe('GET /proxy', () => {
  it('refuses hosts outside fal.media, including look-alikes', async () => {
    for (const target of [
      'https://example.com/x.glb',
      'https://fal.media.evil.example/x.glb',
      'https://notfal.media/x.glb',
      'https://fal.media@evil.example/x.glb',
      'ftp://fal.media/x.glb',
    ]) {
      const res = await app.request(`/proxy?url=${encodeURIComponent(target)}`);
      expect(res.status, target).toBe(400);
    }
  });

  it('rejects a missing or unparsable url', async () => {
    expect((await app.request('/proxy')).status).toBe(400);
    expect((await app.request('/proxy?url=not-a-url')).status).toBe(400);
  });
});

describe('CORS', () => {
  it('answers a preflight from an allowed origin', async () => {
    const res = await app.request(
      '/api/fal/models',
      { method: 'OPTIONS', headers: { Origin: 'https://panel.example', 'Access-Control-Request-Method': 'GET' } },
    );
    expect(res.headers.get('access-control-allow-origin')).toBe('https://panel.example');
  });

  it('does not vouch for a foreign origin', async () => {
    const res = await app.request(
      '/api/fal/models',
      { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'GET' } },
    );
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('GET /proxy relaying', () => {
  const upstream = (init: { status?: number; headers?: Record<string, string>; body?: string }) =>
    new Response(init.body ?? 'bytes', { status: init.status ?? 200, headers: init.headers ?? {} });

  it('relays media with hardening headers and CORS', async () => {
    const fetchMock = vi.fn(async () => upstream({ headers: { 'content-type': 'model/gltf-binary', 'content-length': '5' } }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await app.request('/proxy?url=' + encodeURIComponent('https://v3.fal.media/files/x.glb'));
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect((fetchMock.mock.calls[0] as unknown[])[1]).toMatchObject({ redirect: 'manual' });
    vi.unstubAllGlobals();
  });

  it('refuses to relay a non-media content type from the CDN', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => upstream({ headers: { 'content-type': 'text/html; charset=utf-8' }, body: '<script>1</script>' })));
    const res = await app.request('/proxy?url=' + encodeURIComponent('https://v3.fal.media/files/evil.html'));
    expect(res.status).toBe(415);
    vi.unstubAllGlobals();
  });

  it('refuses an oversized asset', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => upstream({ headers: { 'content-type': 'video/mp4', 'content-length': String(2 * 1024 ** 3) } })));
    const res = await app.request('/proxy?url=' + encodeURIComponent('https://v3.fal.media/files/huge.mp4'));
    expect(res.status).toBe(413);
    vi.unstubAllGlobals();
  });

  it('follows a redirect only while it stays on the CDN', async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        seen.push(url);
        if (url.endsWith('/a.glb')) return upstream({ status: 302, headers: { location: 'https://v3b.fal.media/files/b.glb' } });
        return upstream({ headers: { 'content-type': 'model/gltf-binary' } });
      }),
    );
    const ok = await app.request('/proxy?url=' + encodeURIComponent('https://v3.fal.media/files/a.glb'));
    expect(ok.status).toBe(200);
    expect(seen).toEqual(['https://v3.fal.media/files/a.glb', 'https://v3b.fal.media/files/b.glb']);
    vi.unstubAllGlobals();

    vi.stubGlobal('fetch', vi.fn(async () => upstream({ status: 302, headers: { location: 'https://169.254.169.254/latest/meta-data' } })));
    const bad = await app.request('/proxy?url=' + encodeURIComponent('https://v3.fal.media/files/a.glb'));
    expect(bad.status).toBe(502);
    vi.unstubAllGlobals();
  });

  it('classifies content types', () => {
    expect(isProxyableContentType('image/png')).toBe(true);
    expect(isProxyableContentType('video/mp4')).toBe(true);
    expect(isProxyableContentType('audio/mpeg')).toBe(true);
    expect(isProxyableContentType('model/gltf-binary')).toBe(true);
    expect(isProxyableContentType('application/octet-stream')).toBe(true);
    expect(isProxyableContentType('text/html')).toBe(false);
    expect(isProxyableContentType('application/javascript')).toBe(false);
    expect(isProxyableContentType('image/svg+xml')).toBe(true); // image/*, still no scripts thanks to CSP sandbox
    expect(isProxyableContentType(null)).toBe(false);
  });
});

describe('healthz and key comparison', () => {
  it('tells anonymous callers only that it is up', async () => {
    const res = await app.request('/healthz');
    expect(await res.json()).toEqual({ ok: true });
  });

  it('tells a caller holding the key which keys are configured', async () => {
    const res = await app.request('/healthz', { headers: authed });
    expect(await res.json()).toEqual({ ok: true, hasKey: true, hasAdminKey: false });
  });

  it('compares keys in constant time semantics', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'ab')).toBe(false);
    expect(constantTimeEqual('', '')).toBe(true);
    expect(constantTimeEqual('', 'a')).toBe(false);
  });
});
