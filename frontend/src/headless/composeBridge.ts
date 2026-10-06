// The headless half of the embed-compose channel (see shared/compose.ts).
// embed-compose.html renders a video in the browser; this iframe has the SDK
// and the connection, so it hosts the file on Fal's CDN and places it on the
// board as an embed-video.html embed beside the compose embed.
//
// Nothing here runs a model or spends credits beyond Fal storage. Only
// same-origin messages are accepted (isOurs), and replies go back to the
// asking frame at our own origin.

import { api, videoEmbedUrl } from '../lib/api';
import { createEmbedAtPosition } from '../shared/boardHelpers';
import { COMPOSE_MSG, parseComposeRequest, placementFor, type ComposePlace } from '../shared/compose';
import { isOurs, ownOrigin } from '../shared/frameMessaging';

type Rect = { x: number; y: number; width: number; height: number };

function reply(event: MessageEvent, payload: Record<string, unknown>): void {
  (event.source as Window | null)?.postMessage({ v: 1, ...payload }, ownOrigin());
}

/** The compose embed this export came from, found by the `cid` in its URL. */
async function findComposeEmbed(cid: string | null): Promise<Rect | null> {
  if (!cid) return null;
  try {
    const embeds = (await miro.board.get({ type: 'embed' })) as Array<Rect & { url?: string }>;
    const needle = `cid=${encodeURIComponent(cid)}`;
    const hit = embeds.find((e) => typeof e.url === 'string' && e.url.includes('embed-compose.html') && e.url.includes(needle));
    return hit ? { x: hit.x, y: hit.y, width: hit.width, height: hit.height } : null;
  } catch {
    return null;
  }
}

/** One placement at a time per request id, so a double click can't upload twice. */
const inFlight = new Set<string>();

async function place(event: MessageEvent, req: ComposePlace): Promise<void> {
  if (inFlight.has(req.rid)) return;
  inFlight.add(req.rid);
  try {
    reply(event, { type: COMPOSE_MSG.progress, rid: req.rid, message: 'Uploading to Fal…' });
    const url = await api.upload(req.video);
    reply(event, { type: COMPOSE_MSG.progress, rid: req.rid, message: 'Adding to the board…' });
    const [anchor, viewport] = await Promise.all([findComposeEmbed(req.cid), miro.board.viewport.get()]);
    const at = placementFor({ width: req.width, height: req.height }, anchor, viewport);
    const embed = await createEmbedAtPosition({ url: videoEmbedUrl(url), ...at });
    reply(event, { type: COMPOSE_MSG.placed, rid: req.rid, url, embedId: embed.id });
  } catch (e) {
    reply(event, { type: COMPOSE_MSG.error, rid: req.rid, error: e instanceof Error ? e.message : String(e) });
  } finally {
    inFlight.delete(req.rid);
  }
}

export function initComposeBridge(): void {
  window.addEventListener('message', (event) => {
    if (!isOurs(event)) return;
    const req = parseComposeRequest(event.data);
    if (!req) return;
    if (req.type === COMPOSE_MSG.ping) {
      reply(event, { type: COMPOSE_MSG.pong, rid: req.rid });
      return;
    }
    place(event, req).catch((err) => console.error('[composeBridge] handler error:', err));
  });
}
