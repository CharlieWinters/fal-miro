// Compose embeds — the board half: creating one beside a video, and finding
// it again by cid. Mirrors nodeBoard.ts: the URL narrows the search, the
// metadata (which only this app can write) decides.

import { composeEmbedUrl, unwrapVideoEmbedUrl } from '../lib/api';
import { createEmbedAtPosition, resolveAbsolutePosition } from './boardHelpers';
import { COMPOSE_CANVAS, COMPOSE_EMBED_SIZE, COMPOSE_METADATA_KEY, COMPOSE_VERSION, parseComposeMeta, type ComposeMeta } from './compose';

type Rect = { x: number; y: number; width: number; height: number };
type MetaItem = Rect & {
  id: string;
  type: string;
  url?: string;
  getMetadata: (key: string) => Promise<unknown>;
  setMetadata: (key: string, value: unknown) => Promise<unknown>;
};

/**
 * Open a compose canvas on a video embed: a new embed-compose.html embed just
 * right of it, carrying a fresh cid in its URL and its metadata.
 */
export async function createComposeFromVideo(videoEmbedId: string): Promise<{ embedId: string; cid: string }> {
  const source = (await miro.board.getById(videoEmbedId)) as unknown as MetaItem | null;
  const videoUrl = source?.type === 'embed' && source.url ? unwrapVideoEmbedUrl(source.url) : null;
  if (!videoUrl) throw new Error('Select a video embed first.');
  const pos = await resolveAbsolutePosition(videoEmbedId);
  if (!pos) throw new Error('Could not locate the video on the board.');

  const cid = crypto.randomUUID();
  const meta: ComposeMeta = { v: COMPOSE_VERSION, cid, source: videoUrl };
  const embed = await createEmbedAtPosition({
    url: composeEmbedUrl(videoUrl, cid, COMPOSE_CANVAS),
    // Top-aligned with the video, a gap to its right (Miro positions by centre).
    x: pos.absoluteX + pos.width / 2 + 60 + COMPOSE_EMBED_SIZE.width / 2,
    y: pos.absoluteY - pos.height / 2 + COMPOSE_EMBED_SIZE.height / 2,
    width: COMPOSE_EMBED_SIZE.width,
    height: COMPOSE_EMBED_SIZE.height,
  });
  const item = (await miro.board.getById(embed.id)) as unknown as MetaItem;
  await item.setMetadata(COMPOSE_METADATA_KEY, meta);
  return { embedId: embed.id, cid };
}

function cidOfUrl(url: string): string | null {
  try {
    const u = new URL(url);
    return u.pathname.endsWith('/embed-compose.html') ? u.searchParams.get('cid') : null;
  } catch {
    return null;
  }
}

/** The compose embed that owns `cid`, or null. A hand-made embed with a copied URL has no metadata, so it never matches. */
export async function findComposeByCid(cid: string): Promise<Rect | null> {
  const embeds = (await miro.board.get({ type: 'embed' })) as unknown as MetaItem[];
  for (const embed of embeds) {
    if (!embed.url || cidOfUrl(embed.url) !== cid) continue;
    try {
      const meta = parseComposeMeta(await embed.getMetadata(COMPOSE_METADATA_KEY));
      if (meta?.cid === cid) return { x: embed.x, y: embed.y, width: embed.width, height: embed.height };
    } catch {
      /* not readable — keep looking */
    }
  }
  return null;
}
