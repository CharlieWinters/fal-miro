// The embed-compose channel: embed-compose.html (an embed on the board, no
// SDK) hands a video it rendered to the headless iframe, which hosts it on
// Fal's CDN and places it on the board as an embed-video.html embed.
//
// Same transport and trust model as the node channel (see node.ts): the page
// walks the frame tree and posts at our own origin only; the headless side
// accepts only same-origin messages (isOurs). The page is a static file with
// no bundler, so it repeats these message names inline — keep them in step.
//
// Like a node, a compose embed is created by this app (composeBoard.ts) and
// identified by a random `cid`: in the embed URL so the page knows it, and in
// the embed's metadata so the app can find it. Only this app can write that
// metadata, so the URL alone never decides.

import { isNid } from './node';

/** Item metadata key on compose embeds. */
export const COMPOSE_METADATA_KEY = 'falCompose';
export const COMPOSE_VERSION = 1;

/** What a compose embed carries in its metadata. */
export type ComposeMeta = {
  v: typeof COMPOSE_VERSION;
  /** Random UUID, also the `cid` query param of the embed URL. */
  cid: string;
  /** The cut-out video the canvas was opened on. */
  source: string;
};

export function parseComposeMeta(data: unknown): ComposeMeta | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (d.v !== COMPOSE_VERSION || typeof d.cid !== 'string' || !isNid(d.cid)) return null;
  if (typeof d.source !== 'string' || !/^https:\/\//.test(d.source)) return null;
  return { v: COMPOSE_VERSION, cid: d.cid, source: d.source };
}

/** Default canvas and on-board size of a new compose embed. */
export const COMPOSE_CANVAS = { width: 1920, height: 1080 } as const;
export const COMPOSE_EMBED_SIZE = { width: 1200, height: 800 } as const;

export const COMPOSE_MSG = {
  /** Page → headless: is the app here? */
  ping: 'fal-compose:ping',
  /** Headless → page: yes. */
  pong: 'fal-compose:pong',
  /** Page → headless: upload this video and put it on the board. */
  place: 'fal-compose:place',
  /** Headless → page: progress text while uploading/placing. */
  progress: 'fal-compose:progress',
  /** Headless → page: done. */
  placed: 'fal-compose:placed',
  error: 'fal-compose:error',
} as const;

/** Largest export we'll take — matches the backend's upload cap. */
export const COMPOSE_MAX_BYTES = 95 * 1024 * 1024;

export type ComposePing = { type: typeof COMPOSE_MSG.ping; v: 1; rid: string };
export type ComposePlace = {
  type: typeof COMPOSE_MSG.place;
  v: 1;
  rid: string;
  /** The compose embed's cid (from its URL), so the result lands beside it. */
  cid: string | null;
  video: Blob;
  width: number;
  height: number;
};
export type ComposeRequest = ComposePing | ComposePlace;

const isRid = (s: unknown): s is string => typeof s === 'string' && /^[a-z0-9_-]{4,64}$/i.test(s);
const isCid = (s: unknown): s is string => typeof s === 'string' && isNid(s);
const isDim = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 16 && n <= 8192;

/** Validate what the page sent. Anything else — including oversized or non-video blobs — is ignored. */
export function parseComposeRequest(data: unknown): ComposeRequest | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (d.v !== 1 || !isRid(d.rid)) return null;
  if (d.type === COMPOSE_MSG.ping) return { type: COMPOSE_MSG.ping, v: 1, rid: d.rid };
  if (d.type !== COMPOSE_MSG.place) return null;
  const video = d.video;
  if (typeof Blob === 'undefined' || !(video instanceof Blob)) return null;
  if (!video.size || video.size > COMPOSE_MAX_BYTES || !/^video\//.test(video.type)) return null;
  if (!isDim(d.width) || !isDim(d.height)) return null;
  return {
    type: COMPOSE_MSG.place,
    v: 1,
    rid: d.rid,
    cid: isCid(d.cid) ? d.cid : null,
    video,
    width: d.width,
    height: d.height,
  };
}

/**
 * Size and position for the placed embed: the video's aspect ratio at a
 * board-friendly size, just right of the compose embed (or centred on the
 * viewport when the compose embed can't be found).
 */
export function placementFor(
  video: { width: number; height: number },
  anchor: { x: number; y: number; width: number; height: number } | null,
  viewport: { x: number; y: number; width: number; height: number },
): { x: number; y: number; width: number; height: number } {
  const longEdge = 800;
  const k = longEdge / Math.max(video.width, video.height);
  const width = Math.round(video.width * k);
  const height = Math.round(video.height * k);
  if (anchor) {
    // Miro positions items by their centre.
    return { x: anchor.x + anchor.width / 2 + 60 + width / 2, y: anchor.y, width, height };
  }
  return { x: viewport.x + viewport.width / 2, y: viewport.y + viewport.height / 2, width, height };
}
