// Which realtime (WMA / WebRTC) calls /api/fal/realtime-proxy will relay.
//
// The browser side is @fal-ai/client's `fal.realtime.open(wma(...))`, configured
// with this route as its `proxyUrl`. The client never holds a key: it sends each
// request here with the real destination in `x-fal-target-url`, and this route
// adds FAL_KEY and forwards it. That is fal's documented proxy protocol, so the
// client needs nothing custom.
//
// What a WMA session actually calls (read from @fal-ai/client 1.11.0-alpha.4,
// src/realtime/wma.js):
//
//   POST https://wma.fal.run/ice                { app_id }            TURN credentials
//   POST https://wma.fal.run/session            { app_id, sdp, type } SDP offer → answer
//   POST https://wma.fal.run/session/heartbeat  { session_id }        every few seconds
//   POST https://fal.run/<app_id>/ice           {}                    fallback ICE vending
//
// A general-purpose proxy would let anyone holding BACKEND_KEY spend FAL_KEY on
// any fal app at all. This one is held to exactly those four calls, and the two
// that name an app must name one of REALTIME_APPS.

/** Realtime apps the board may open. Add one here to allow it. */
export const REALTIME_APPS = new Set(['minimax/h3-max/director']);

/** SDP offers are a few KB; nothing a session sends comes close to this. */
export const REALTIME_PROXY_MAX_BYTES = 256 * 1024;

export type RealtimeTarget = { url: URL; method: 'GET' | 'POST' };

/**
 * Returns the parsed target when `rawUrl` + `method` + `body` is one of the calls
 * above, or a reason string when it is not. Never throws.
 */
export function checkRealtimeTarget(
  rawUrl: string | undefined,
  method: string,
  body: string,
): RealtimeTarget | string {
  if (!rawUrl) return 'x-fal-target-url header is required';
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return 'x-fal-target-url is not a URL';
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) {
    return 'x-fal-target-url must be a plain https URL';
  }
  const m = method.toUpperCase();
  if (m !== 'POST') return 'only POST is relayed';

  let json: Record<string, unknown> = {};
  if (body) {
    try {
      const parsed = JSON.parse(body);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) json = parsed;
      else return 'body must be a JSON object';
    } catch {
      return 'body must be JSON';
    }
  }
  const appIdAllowed = () => typeof json.app_id === 'string' && REALTIME_APPS.has(json.app_id);

  const host = url.host.toLowerCase();
  if (host === 'wma.fal.run') {
    if (url.search) return 'unexpected query string';
    if (url.pathname === '/ice' || url.pathname === '/session') {
      return appIdAllowed() ? { url, method: 'POST' } : 'app_id is not an allowed realtime app';
    }
    if (url.pathname === '/session/heartbeat') {
      return typeof json.session_id === 'string' && json.session_id
        ? { url, method: 'POST' }
        : 'heartbeat needs a session_id';
    }
    return 'that WMA path is not relayed';
  }
  if (host === 'fal.run') {
    for (const appId of REALTIME_APPS) {
      if (url.pathname === `/${appId}/ice`) return { url, method: 'POST' };
    }
    return 'that fal.run path is not relayed';
  }
  return 'x-fal-target-url host is not relayed';
}
