// Embed nodes — the board half: finding a node, turning a settings card into
// one, and recording a result on it. See node.ts for the design and the
// security rules this follows.

import { nodePageUrl, nodePosterUrl } from '../lib/api';
import { asPreviewUrl, createEmbedAtPosition, resolveAbsolutePosition } from './boardHelpers';
import { postToAllFrames } from './frameMessaging';
import {
  NODE_METADATA_KEY,
  NODE_MSG,
  NODE_SIZE,
  NODE_VERSION,
  nodeTitleFromCard,
  parseNodeMeta,
  type NodeMeta,
  type NodeOutput,
} from './node';
import { parseRecipeCard } from './recipeCard';

type MetaItem = {
  id: string;
  type: string;
  url?: string;
  getMetadata: (key: string) => Promise<unknown>;
  setMetadata: (key: string, value: unknown) => Promise<unknown>;
};

/** Read a node's metadata, or null if the item is not one of our nodes. */
export async function readNode(embedId: string): Promise<{ embed: MetaItem; meta: NodeMeta } | null> {
  let item: MetaItem | null;
  try {
    item = (await miro.board.getById(embedId)) as unknown as MetaItem | null;
  } catch {
    return null; // not on the board
  }
  if (!item || item.type !== 'embed' || typeof item.getMetadata !== 'function') return null;
  try {
    const meta = parseNodeMeta(await item.getMetadata(NODE_METADATA_KEY));
    return meta ? { embed: item, meta } : null;
  } catch {
    return null;
  }
}

/**
 * nid → embed id. Nodes re-announce themselves often (Miro resets off-screen
 * embeds, and each one retries its hello), and every lookup is SDK calls
 * against an hourly credit budget — the same reason miro-terminal caches.
 * Short enough that a deleted or duplicated node heals without invalidation.
 */
const nidCache = new Map<string, { embedId: string; at: number }>();
const NID_CACHE_TTL_MS = 30_000;

/**
 * Find the node embed that owns `nid`.
 *
 * The embed URL is only used to narrow the search. What decides is the
 * metadata: only this app can write it, so an embed someone authored by hand
 * with a copied node URL is not a node.
 */
export async function findNodeByNid(nid: string): Promise<{ embed: MetaItem; meta: NodeMeta } | null> {
  const hit = nidCache.get(nid);
  if (hit && Date.now() - hit.at < NID_CACHE_TTL_MS) {
    const node = await readNode(hit.embedId);
    if (node?.meta.nid === nid) return node;
    nidCache.delete(nid);
  }
  const embeds = (await miro.board.get({ type: 'embed' })) as unknown as MetaItem[];
  for (const embed of embeds) {
    if (!embed.url || nidOfUrl(embed.url) !== nid) continue;
    const node = await readNode(embed.id);
    if (node?.meta.nid === nid) {
      nidCache.set(nid, { embedId: embed.id, at: Date.now() });
      return node;
    }
  }
  return null;
}

function nidOfUrl(url: string): string | null {
  try {
    const u = new URL(url);
    return u.pathname.endsWith('/node.html') ? u.searchParams.get('nid') : null;
  } catch {
    return null;
  }
}

type CardItem = {
  id: string;
  type: string;
  title?: string;
  description?: string;
  parentId?: string | null;
};

type ConnectorItem = {
  id: string;
  start?: { item?: string; position?: { x: number; y: number }; snapTo?: string };
  end?: { item?: string; position?: { x: number; y: number }; snapTo?: string };
  shape?: string;
  style?: Record<string, unknown>;
  captions?: Array<{ content?: string; position?: number; textAlignVertical?: string }>;
};

/**
 * Turn a settings card into a node, in place.
 *
 * The node takes the card's position and frame, the card's recipe moves into
 * the node's metadata unchanged, and every connector on the card is recreated
 * on the node before the card is deleted (deleting a card deletes its
 * connectors). Order matters: nothing is removed until the node exists and
 * holds the recipe, so a failure part-way leaves the card intact.
 */
export async function convertCardToNode(cardId: string): Promise<{ embedId: string; nid: string }> {
  const card = (await miro.board.getById(cardId)) as unknown as CardItem | null;
  if (!card || card.type !== 'card') throw new Error('That is not a card.');
  const recipe = parseRecipeCard(card.description);
  if (!recipe) throw new Error('That card holds no Fal settings.');

  const pos = await resolveAbsolutePosition(cardId);
  if (!pos) throw new Error('Could not locate the card on the board.');

  const nid = crypto.randomUUID();
  const meta: NodeMeta = { v: NODE_VERSION, nid, title: nodeTitleFromCard(card.title), recipe, lastOutput: null };

  // Same top-left corner as the card. A node is far taller than a card, so
  // centring it on the card would push it up into whatever sits above.
  const embed = await createEmbedAtPosition({
    url: nodePageUrl(nid),
    x: pos.absoluteX - pos.width / 2 + NODE_SIZE.width / 2,
    y: pos.absoluteY - pos.height / 2 + NODE_SIZE.height / 2,
    width: NODE_SIZE.width,
    height: NODE_SIZE.height,
    previewUrl: nodePosterUrl(),
  });
  const node = (await miro.board.getById(embed.id)) as unknown as MetaItem;
  await node.setMetadata(NODE_METADATA_KEY, meta);

  if (card.parentId) {
    try {
      const frame = (await miro.board.getById(card.parentId)) as unknown as { add?: (i: unknown) => Promise<unknown> };
      await frame.add?.(node);
    } catch (e) {
      console.warn('[node] could not put the node in the card’s frame', e);
    }
  }

  const connectors = (await miro.board.get({ type: 'connector' })) as unknown as ConnectorItem[];
  const createConnector = (miro.board as unknown as {
    createConnector: (o: Record<string, unknown>) => Promise<unknown>;
  }).createConnector;
  for (const c of connectors) {
    const s = c.start?.item;
    const e = c.end?.item;
    if (s !== cardId && e !== cardId) continue;
    const end = (side: ConnectorItem['start'], isCard: boolean) =>
      isCard
        ? { item: embed.id, snapTo: 'left' }
        : { item: side?.item, ...(side?.position ? { position: side.position } : { snapTo: side?.snapTo ?? 'auto' }) };
    try {
      await createConnector({
        shape: c.shape ?? 'curved',
        ...(c.style ? { style: c.style } : {}),
        ...(c.captions?.length ? { captions: c.captions.map((k) => ({ content: k.content ?? '' })) } : {}),
        start: end(c.start, s === cardId),
        end: end(c.end, e === cardId),
      });
    } catch (err) {
      console.warn('[node] could not move connector', c.id, err);
    }
  }

  await (miro.board as unknown as { remove: (i: unknown) => Promise<void> }).remove(card);
  nidCache.set(nid, { embedId: embed.id, at: Date.now() });
  return { embedId: embed.id, nid };
}

/**
 * After a run started from a node: remember the result on the node, make it
 * the node's poster, and tell the node to refresh. A no-op for anything that
 * is not a node (a plain settings card, a selection-started run), and never
 * throws — the output is already on the board and paid for.
 */
export async function recordNodeOutput(
  anchorId: string | undefined,
  output: Omit<NodeOutput, 'at' | 'by'>,
): Promise<void> {
  if (!anchorId) return;
  try {
    const node = await readNode(anchorId);
    if (!node) return;
    let by: string | null = null;
    try {
      const user = (await miro.board.getUserInfo()) as unknown as { name?: string };
      by = user?.name ?? null;
    } catch {
      /* identity is optional */
    }
    const lastOutput: NodeOutput = { ...output, at: new Date().toISOString(), by };
    await node.embed.setMetadata(NODE_METADATA_KEY, { ...node.meta, lastOutput });

    const poster = asPreviewUrl(output.kind === 'image' ? output.url : output.posterUrl);
    if (poster) {
      try {
        const embed = node.embed as unknown as { previewUrl?: string; sync: () => Promise<void> };
        embed.previewUrl = poster;
        await embed.sync();
      } catch (e) {
        console.warn('[node] could not update the node poster', e);
      }
    }
    postToAllFrames({ type: NODE_MSG.changed, v: 1, nid: node.meta.nid });
  } catch (e) {
    console.warn('[node] could not record the result on the node', e);
  }
}
