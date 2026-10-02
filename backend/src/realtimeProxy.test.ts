import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@fal-ai/client', () => ({ fal: { config: vi.fn(), queue: {} } }));

import { app } from './app.js';
import { checkRealtimeTarget } from './lib/realtimeProxy.js';

const DIRECTOR = 'minimax/h3-max/director';
const env = { FAL_KEY: 'test-fal', BACKEND_KEY: 'shared-secret', ALLOWED_ORIGINS: 'https://panel.example' };
const authed = { 'x-fal-proxy-key': 'shared-secret' };

describe('checkRealtimeTarget', () => {
  const ok = (url: string, body: unknown) => {
    const r = checkRealtimeTarget(url, 'POST', JSON.stringify(body));
    expect(typeof r).not.toBe('string');
  };
  const no = (url: string | undefined, body: unknown, method = 'POST') => {
    const r = checkRealtimeTarget(url, method, typeof body === 'string' ? body : JSON.stringify(body));
    expect(typeof r).toBe('string');
  };

  it('relays the four calls a WMA session makes, for an allowed app', () => {
    ok('https://wma.fal.run/ice', { app_id: DIRECTOR });
    ok('https://wma.fal.run/session', { app_id: DIRECTOR, sdp: 'v=0', type: 'offer' });
    ok('https://wma.fal.run/session/heartbeat', { session_id: 's1' });
    ok(`https://fal.run/${DIRECTOR}/ice`, {});
  });

  it('refuses another app, even on the right paths', () => {
    no('https://wma.fal.run/session', { app_id: 'someone/else', sdp: 'v=0', type: 'offer' });
    no('https://wma.fal.run/ice', {});
    no('https://fal.run/fal-ai/flux/dev', { prompt: 'x' });
  });

  it('refuses other hosts, paths, methods and URL tricks', () => {
    no(undefined, {});
    no('not a url', {});
    no('http://wma.fal.run/session', { app_id: DIRECTOR });
    no('https://wma.fal.run.evil.example/session', { app_id: DIRECTOR });
    no('https://user:pw@wma.fal.run/session', { app_id: DIRECTOR });
    no('https://wma.fal.run:8443/session', { app_id: DIRECTOR });
    no('https://wma.fal.run/session?x=1', { app_id: DIRECTOR });
    no('https://wma.fal.run/admin', { app_id: DIRECTOR });
    no('https://queue.fal.run/minimax/h3-max/director', {});
    no('https://wma.fal.run/session', { app_id: DIRECTOR }, 'GET');
    no('https://wma.fal.run/session/heartbeat', {});
    no('https://wma.fal.run/session', 'not json');
    no('https://wma.fal.run/session', '[1,2]');
  });
});

describe('POST /api/fal/realtime-proxy', () => {
  const upstream = vi.fn();
  beforeEach(() => {
    Object.assign(process.env, env);
    upstream.mockReset();
    vi.stubGlobal('fetch', upstream);
  });
  afterEach(() => vi.unstubAllGlobals());

  const call = (target: string, body: unknown, headers: Record<string, string> = authed) =>
    app.request('/api/fal/realtime-proxy', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', 'x-fal-target-url': target },
      body: JSON.stringify(body),
    });

  it('needs the backend key like every /api/fal/* route', async () => {
    const res = await call('https://wma.fal.run/session', { app_id: DIRECTOR }, {});
    expect(res.status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('forwards an allowed call with FAL_KEY attached and relays the answer', async () => {
    upstream.mockResolvedValue(
      new Response(JSON.stringify({ session_id: 's1', sdp: 'v=0', type: 'answer' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const res = await call('https://wma.fal.run/session', { app_id: DIRECTOR, sdp: 'v=0', type: 'offer' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ session_id: 's1', sdp: 'v=0', type: 'answer' });
    const [url, init] = upstream.mock.calls[0];
    expect(url).toBe('https://wma.fal.run/session');
    expect(init.headers.Authorization).toBe('Key test-fal');
    expect(init.redirect).toBe('manual');
  });

  it('refuses a disallowed target with 403 and never calls upstream', async () => {
    const res = await call('https://fal.run/fal-ai/flux/dev', { prompt: 'spend' });
    expect(res.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('does not follow a redirect', async () => {
    upstream.mockResolvedValue(new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }));
    const res = await call('https://wma.fal.run/session/heartbeat', { session_id: 's1' });
    expect(res.status).toBe(502);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it('lets the browser send x-fal-target-url cross-origin', async () => {
    const res = await app.request('/api/fal/realtime-proxy', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://panel.example',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'x-fal-target-url,x-fal-proxy-key,content-type',
      },
    });
    expect(res.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('x-fal-target-url');
  });
});
