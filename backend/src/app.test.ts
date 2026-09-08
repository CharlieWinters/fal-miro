import { beforeEach, describe, expect, it, vi } from 'vitest';

// The fal client is module-level state; stub the pieces the routes touch.
const queue = vi.hoisted(() => ({
  submit: vi.fn(),
  status: vi.fn(),
  result: vi.fn(),
  cancel: vi.fn(),
}));
vi.mock('@fal-ai/client', () => ({ fal: { config: vi.fn(), queue } }));

import { app, terminalStatusFor } from './app.js';

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

  it('classifies HTTP statuses', () => {
    expect(terminalStatusFor(422)).toBe('FAILED');
    expect(terminalStatusFor(400)).toBe('FAILED');
    expect(terminalStatusFor(404)).toBe('UNKNOWN');
    expect(terminalStatusFor(429)).toBeNull();
    expect(terminalStatusFor(500)).toBeNull();
    expect(terminalStatusFor(undefined)).toBeNull();
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
