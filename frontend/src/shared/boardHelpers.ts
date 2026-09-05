// Thin wrappers around the Miro Web SDK shared across agents. Adapted from the
// Board helpers shared by the agents and screens.

import { unwrapVideoEmbedUrl, unwrapAudioEmbedUrl } from '../lib/api';

export type MiroImageItem = {
  id: string;
  type: 'image';
  title?: string;
  url?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  getDataUrl?: () => Promise<string>;
};

// Short-lived cache over full-board item queries (connectors / images / embeds).
// These return every item of a type, so they're the priciest Miro calls — rapid
// re-scans (e.g. on each selection change) reuse the result for a moment.
const boardQueryCache = new Map<string, { at: number; p: Promise<unknown[]> }>();
const BOARD_QUERY_TTL_MS = 2000;

/**
 * All items of `type`, or every item on the board if `type` is omitted.
 * The no-filter form matters for classifications the SDK invents itself
 * rather than a real underlying widget type (e.g. `'unsupported'`) —
 * filtering server-side by a label that isn't a genuine type is unverified
 * and risky, so callers needing those fetch everything and filter
 * client-side instead.
 */
export async function cachedBoardGet(type?: string): Promise<unknown[]> {
  const key = type ?? '__all__';
  const hit = boardQueryCache.get(key);
  if (hit && Date.now() - hit.at < BOARD_QUERY_TTL_MS) return hit.p;
  const get = miro.board.get as unknown as (o?: { type?: string }) => Promise<unknown[]>;
  const p = get(type ? { type } : undefined).catch((e) => {
    boardQueryCache.delete(key); // don't cache a failed query
    throw e;
  });
  boardQueryCache.set(key, { at: Date.now(), p });
  return p;
}

/** Ratio string "W:H" → numeric { width, height } at a reasonable display size. */
export function parseRatio(ratio: string, maxDim = 720): { width: number; height: number } {
  const [w, h] = ratio.split(':').map((n) => parseInt(n, 10));
  if (!w || !h) return { width: maxDim, height: maxDim };
  const scale = maxDim / Math.max(w, h);
  return { width: Math.round(w * scale), height: Math.round(h * scale) };
}

/** XML-escape text before it goes into the SVG. Error messages are why this
 *  matters: they are upstream text that can contain &, <, or a quote, any one
 *  of which corrupts the document so the board renders nothing at all. */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Greedy word wrap for placeholder text. SVG has no auto-wrap, so the line
 * breaks have to be decided here. A single token longer than the line (a URL
 * inside an error) is hard-split rather than allowed to overflow the card, and
 * anything past `maxLines` is dropped with an ellipsis — the placeholder is a
 * signpost, not a log viewer.
 */
export function wrapPlaceholderText(text: string, maxChars: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';
  const flush = () => {
    if (current) {
      lines.push(current);
      current = '';
    }
  };

  for (const word of words) {
    let rest = word;
    while (rest.length > maxChars && lines.length <= maxLines) {
      flush();
      lines.push(`${rest.slice(0, maxChars - 1)}-`);
      rest = rest.slice(maxChars - 1);
    }
    if (!rest) continue;
    if (!current) current = rest;
    else if (current.length + 1 + rest.length <= maxChars) current += ` ${rest}`;
    else {
      flush();
      current = rest;
    }
  }
  flush();

  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  const last = kept[maxLines - 1];
  kept[maxLines - 1] = `${last.length > maxChars - 1 ? last.slice(0, maxChars - 1) : last}…`;
  return kept;
}

/** How much of a failure message the card shows before truncating. */
const MAX_DETAIL_LINES = 5;

/**
 * A tiny inline SVG placeholder data-URI sized to the requested ratio.
 *
 * `detail` is what makes a failure placeholder worth looking at. Without it a
 * failed generation is a card reading "Failed", while the actual cause — which
 * Fal usually states precisely, e.g. "video_urls.0: Video dimensions are too
 * small. Minimum dimensions are 300x300 pixels. Found 320x240 pixels." — is
 * only visible in the network tab. Pass `describeFalError(err)` from
 * shared/falError.ts, which reads the same in both connection modes.
 */
export function makePlaceholderDataUrl(ratio: string, label = 'Generating…', detail?: string): string {
  const { width, height } = parseRatio(ratio, 1024);
  // Dark card matching the redesign: near-black fill, hairline border, yellow
  // label, and a thin accent bar suggesting progress.
  const min = Math.min(width, height);
  const labelSize = Math.round(min / 16);
  const detailSize = Math.round(min / 34);
  // ~0.55em average glyph width for this family, with 8% padding each side.
  const maxChars = Math.max(16, Math.floor((width * 0.84) / (detailSize * 0.55)));
  const lines = detail ? wrapPlaceholderText(detail, maxChars, MAX_DETAIL_LINES) : [];

  const barW = Math.round(width * 0.4);
  const barX = Math.round((width - barW) / 2);
  const barY = Math.round(height * 0.62);
  const lineStep = Math.round(detailSize * 1.45);
  const detailTop = Math.round(height * 0.46);

  // With a message to show, the label moves up to make room and the progress
  // bar goes away — there is no progress left to suggest.
  const body = lines.length
    ? `<text x="50%" y="38%" fill="#FFDD33" font-size="${labelSize}" font-weight="700">${escapeXml(label)}</text>
    ${lines
      .map(
        (line, i) =>
          `<text x="50%" y="${detailTop + i * lineStep}" fill="#C9C9D1" font-size="${detailSize}">${escapeXml(line)}</text>`,
      )
      .join('\n    ')}`
    : `<text x="50%" y="46%" fill="#FFDD33" font-size="${labelSize}" font-weight="700">${escapeXml(label)}</text>
    <text x="50%" y="53%" fill="#8a8a92" font-size="${Math.round(min / 30)}">${width} × ${height}</text>`;

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" rx="14" fill="#141417"/>
  <rect x="1" y="1" width="${width - 2}" height="${height - 2}" rx="13" fill="none" stroke="#FFDD33" stroke-opacity="0.35" stroke-width="2"/>
  <g font-family="'Roobert PRO', system-ui, sans-serif" text-anchor="middle">
    ${body}
  </g>${
    lines.length
      ? ''
      : `
  <rect x="${barX}" y="${barY}" width="${barW}" height="4" rx="2" fill="#FFDD33" fill-opacity="0.5"/>`
  }
</svg>`;
  // btoa is Latin1-only; the default label contains "…" (U+2026) so UTF-8 encode first.
  const bytes = new TextEncoder().encode(svg);
  const binary = String.fromCharCode(...bytes);
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}

/**
 * Strip HTML tags from sticky-note content (Miro stores stickies as
 * `<p>…</p>`). `textContent` has no concept of block-level spacing, so
 * without inserting real newlines at block boundaries first, "...end of a
 * sentence.</p><p>Start of the next..." collapses into one run-on string
 * with nothing between them. Blank lines are dropped, not just collapsed —
 * "<p></p>" and the like shouldn't leave a bare newline behind.
 */
export function stripHtml(html: string): string {
  if (!html) return '';
  const withBreaks = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|blockquote|tr)>/gi, '\n');
  const d = document.createElement('div');
  d.innerHTML = withBreaks;
  const text = d.textContent ?? d.innerText ?? '';
  return text
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

/** Read a sticky note's plain-text content by id. */
export async function getStickyText(itemId: string): Promise<string> {
  try {
    const item = (await miro.board.getById(itemId)) as { content?: string } | null;
    return stripHtml(item?.content ?? '');
  } catch (e) {
    console.warn('[boardHelpers] getStickyText failed', e);
    return '';
  }
}

/** Every board item id connected (via a connector) to `itemId`. */
export async function getConnectedPartnerIds(itemId: string): Promise<string[]> {
  const connectors = await cachedBoardGet('connector');
  const partners = new Set<string>();
  for (const c of connectors as Array<{ start?: { item?: string }; end?: { item?: string } }>) {
    const s = c.start?.item;
    const e = c.end?.item;
    if (!s || !e) continue;
    if (s === itemId) partners.add(e);
    else if (e === itemId) partners.add(s);
  }
  return [...partners];
}

/**
 * Resolve image items connected to a sticky note via board connectors. Fal
 * image-to-image / edit models take these as `image_url` inputs.
 */
export async function getConnectedReferenceImages(
  stickyId: string,
): Promise<Array<{ miroImageId: string; url?: string; title?: string }>> {
  const partners = await getConnectedPartnerIds(stickyId);
  const results: Array<{ miroImageId: string; url?: string; title?: string }> = [];
  for (const id of partners) {
    try {
      const item = (await miro.board.getById(id)) as MiroImageItem;
      if (item?.type !== 'image') continue;
      // `title` is the image's name on the board — used to map names → positions
      // in the prompt (the Miro reference-naming UX).
      const title = (item.title ?? '').trim() || undefined;
      results.push({ miroImageId: item.id, url: item.url, title });
    } catch (e) {
      console.warn('[boardHelpers] failed to resolve item', id, e);
    }
  }
  return results;
}

/** Sticky notes connected (via connectors) to an item — used to seed the
 *  prompt when an image is selected as the source (image-primary flow). */
export async function getConnectedStickyNotes(
  itemId: string,
): Promise<Array<{ id: string; content: string }>> {
  const partners = await getConnectedPartnerIds(itemId);
  const out: Array<{ id: string; content: string }> = [];
  for (const id of partners) {
    try {
      const item = (await miro.board.getById(id)) as { id: string; type: string; content?: string };
      if (item?.type === 'sticky_note') out.push({ id: item.id, content: stripHtml(item.content ?? '') });
    } catch (e) {
      console.warn('[boardHelpers] getConnectedStickyNotes failed', id, e);
    }
  }
  return out;
}

export type ResolvedBoardItems = {
  images: Array<{ id: string; url?: string; title?: string }>;
  videos: Array<{ id: string; url?: string; title?: string }>;
  audios: Array<{ id: string; url?: string; title?: string }>;
  stickies: Array<{ id: string; content: string }>;
};

/** Images / video-embeds / audio-embeds / sticky notes that are direct
 *  children of any of the given frames. The shared "expand a frame into its
 *  contents" primitive — used both when a frame is part of a
 *  selection/connector list (`resolveBoardItems`) and when a card lives
 *  inside a frame with its references (`getFrameCardResources`). */
async function expandFrameChildren(frameIds: string[]): Promise<ResolvedBoardItems> {
  const images: ResolvedBoardItems['images'] = [];
  const videos: ResolvedBoardItems['videos'] = [];
  const audios: ResolvedBoardItems['audios'] = [];
  const stickies: ResolvedBoardItems['stickies'] = [];
  if (!frameIds.length) return { images, videos, audios, stickies };

  const [imgs, embeds, stickyItems] = await Promise.all([
    cachedBoardGet('image'),
    cachedBoardGet('embed'),
    cachedBoardGet('sticky_note'),
  ]);
  for (const it of imgs as Array<{ id: string; url?: string; title?: string; parentId?: string }>) {
    if (it.parentId && frameIds.includes(it.parentId)) {
      images.push({ id: it.id, url: it.url, title: (it.title ?? '').trim() || undefined });
    }
  }
  for (const it of embeds as Array<{ id: string; url?: string; title?: string; parentId?: string }>) {
    if (!it.parentId || !frameIds.includes(it.parentId) || !it.url) continue;
    const title = (it.title ?? '').trim() || undefined;
    if (unwrapVideoEmbedUrl(it.url)) videos.push({ id: it.id, url: it.url, title });
    else if (unwrapAudioEmbedUrl(it.url)) audios.push({ id: it.id, url: it.url, title });
  }
  for (const it of stickyItems as Array<{ id: string; content?: string; parentId?: string }>) {
    if (it.parentId && frameIds.includes(it.parentId)) {
      stickies.push({ id: it.id, content: stripHtml(it.content ?? '') });
    }
  }
  return { images, videos, audios, stickies };
}

/** Dedup the union of two resolved sets by item id (first occurrence wins). */
function mergeResolved(a: ResolvedBoardItems, b: ResolvedBoardItems): ResolvedBoardItems {
  const dedup = <T extends { id: string }>(items: T[]): T[] => {
    const seen = new Set<string>();
    return items.filter((it) => (seen.has(it.id) ? false : (seen.add(it.id), true)));
  };
  return {
    images: dedup([...a.images, ...b.images]),
    videos: dedup([...a.videos, ...b.videos]),
    audios: dedup([...a.audios, ...b.audios]),
    stickies: dedup([...a.stickies, ...b.stickies]),
  };
}

/**
 * Classify a set of board item ids into images / Fal-video embeds /
 * Fal-audio embeds / sticky notes, expanding any frame among them into its
 * own children. Shared by the settings-card flow both ways: a selected
 * frame's contents count as "used" on save, and a frame connected to an
 * existing card counts as "connected" when reopening it.
 */
type ResolvableItem = { type?: string; url?: string; title?: string; content?: string };

export async function resolveBoardItems(ids: string[]): Promise<ResolvedBoardItems> {
  const images: ResolvedBoardItems['images'] = [];
  const videos: ResolvedBoardItems['videos'] = [];
  const audios: ResolvedBoardItems['audios'] = [];
  const stickies: ResolvedBoardItems['stickies'] = [];
  const frameIds: string[] = [];

  for (const id of ids) {
    let item: ResolvableItem | null;
    try {
      item = (await miro.board.getById(id)) as ResolvableItem;
    } catch (e) {
      console.warn('[resolveBoardItems] failed to resolve item', id, e);
      continue;
    }
    if (!item) continue;
    const title = (item.title ?? '').trim() || undefined;
    if (item.type === 'image') images.push({ id, url: item.url, title });
    else if (item.type === 'embed' && item.url && unwrapVideoEmbedUrl(item.url)) videos.push({ id, url: item.url, title });
    else if (item.type === 'embed' && item.url && unwrapAudioEmbedUrl(item.url)) audios.push({ id, url: item.url, title });
    else if (item.type === 'sticky_note') stickies.push({ id, content: stripHtml(item.content ?? '') });
    else if (item.type === 'frame') frameIds.push(id);
  }

  const fromFrames = await expandFrameChildren(frameIds);
  return mergeResolved({ images, videos, audios, stickies }, fromFrames);
}

/**
 * A settings card's references via frame membership ("prompt frame" model):
 * everything else inside the same frame as the card — images, video embeds,
 * prompt stickies. Returns null if the card has no parent frame.
 */
export async function getFrameCardResources(cardId: string): Promise<ResolvedBoardItems | null> {
  const parentId = await getParentFrameId(cardId);
  if (!parentId) return null;
  return expandFrameChildren([parentId]);
}

/** Everything connected to a board item — e.g. a settings card — via
 *  connector lines (frame-aware, see `resolveBoardItems`) union'd with
 *  whatever else shares its parent frame, if any (see `getFrameCardResources`). */
export async function getConnectedResources(itemId: string): Promise<ResolvedBoardItems> {
  const partnerIds = await getConnectedPartnerIds(itemId);
  const connected = await resolveBoardItems(partnerIds);
  const fromFrame = await getFrameCardResources(itemId);
  return fromFrame ? mergeResolved(connected, fromFrame) : connected;
}

/**
 * The frame id every given item shares as its direct parent, or null if
 * they don't all share one (including "none has a parent frame"). Used to
 * detect a "prompt frame" — a settings card's references already co-located
 * in one frame — so saving can rely on membership instead of drawing a
 * connector per reference.
 */
export async function getCommonFrameParent(itemIds: string[]): Promise<string | null> {
  if (!itemIds.length) return null;
  let common: string | undefined;
  for (const id of itemIds) {
    const item = (await miro.board.getById(id).catch(() => null)) as { parentId?: string } | null;
    if (!item?.parentId) return null;
    if (common === undefined) common = item.parentId;
    else if (common !== item.parentId) return null;
  }
  return common ?? null;
}

/**
 * Placeholder anchor + side for a generation, settings-card aware: when the
 * run was started from a card (`cardAnchorId`), the output places beside it —
 * to the right if the card currently has any connections OR lives in a
 * "prompt frame" with its references (keeps the block visually distinct from
 * its inputs), below if it's bare. Falls back to the ordinary source-item
 * anchor (below it, as always) when there's no card.
 */
export async function resolvePlaceholderAnchor(
  cardAnchorId: string | undefined,
  fallbackAnchorId: string | undefined,
): Promise<{ anchorId: string | undefined; side: 'right' | 'below' }> {
  if (!cardAnchorId) return { anchorId: fallbackAnchorId, side: 'below' };
  const [hasConnections, card] = await Promise.all([
    getConnectedPartnerIds(cardAnchorId).then((p) => p.length > 0),
    miro.board.getById(cardAnchorId).catch(() => null) as Promise<{ parentId?: string } | null>,
  ]);
  return { anchorId: cardAnchorId, side: hasConnections || !!card?.parentId ? 'right' : 'below' };
}

/** The aspect ratio ("W:H") of an item on the board, or null if unknown. */
export async function getImageAspectRatio(itemId: string): Promise<string | null> {
  const pos = await resolveAbsolutePosition(itemId);
  if (!pos || !pos.width || !pos.height) return null;
  return `${Math.round(pos.width)}:${Math.round(pos.height)}`;
}

/** Resolve an image item's data URI + board title in one call. */
export async function getImageRef(
  itemId: string,
): Promise<{ miroImageId: string; url: string; title?: string } | null> {
  const url = await getImageUrl(itemId);
  if (!url) return null;
  let title: string | undefined;
  try {
    const item = (await miro.board.getById(itemId)) as MiroImageItem;
    title = (item?.title ?? '').trim() || undefined;
  } catch {
    /* ignore */
  }
  return { miroImageId: itemId, url, title };
}

/** Resolve a board video-embed item to its underlying Fal video URL + board title. */
export async function getVideoRef(
  itemId: string,
): Promise<{ miroVideoId: string; url: string; title?: string } | null> {
  try {
    const item = (await miro.board.getById(itemId)) as { type?: string; url?: string; title?: string } | null;
    if (!item || item.type !== 'embed' || !item.url) return null;
    const url = unwrapVideoEmbedUrl(item.url);
    if (!url) return null;
    return { miroVideoId: itemId, url, title: (item.title ?? '').trim() || undefined };
  } catch (e) {
    console.warn('[boardHelpers] getVideoRef failed', itemId, e);
    return null;
  }
}

/** Resolve a board audio-embed item to its underlying Fal audio URL + board title. */
export async function getAudioRef(
  itemId: string,
): Promise<{ miroAudioId: string; url: string; title?: string } | null> {
  try {
    const item = (await miro.board.getById(itemId)) as { type?: string; url?: string; title?: string } | null;
    if (!item || item.type !== 'embed' || !item.url) return null;
    const url = unwrapAudioEmbedUrl(item.url);
    if (!url) return null;
    return { miroAudioId: itemId, url, title: (item.title ?? '').trim() || undefined };
  } catch (e) {
    console.warn('[boardHelpers] getAudioRef failed', itemId, e);
    return null;
  }
}

// Hosts whose URLs Fal can fetch directly (its own storage / CDN). For these we
// send the URL as-is rather than a base64 data URI.
const FAL_FETCHABLE_HOST_RE =
  /^https:\/\/([^/]*\.)?(fal\.media|fal\.run|fal\.ai|storage\.googleapis\.com)\//i;

/**
 * A URL Fal can ingest for an image item.
 *
 * Prefers a public, Fal-fetchable URL (e.g. a fal.media output) — it's the
 * pristine image and a tiny payload. Re-encoding into a multi-MB base64 data
 * URI is only needed for images Fal can't fetch (e.g. Miro uploads), and large
 * data URIs can trip request-size limits — notably Veo first/last-frame, which
 * sends two frames in one body.
 */
export async function getImageUrl(itemId: string): Promise<string | null> {
  try {
    const item = (await miro.board.getById(itemId)) as MiroImageItem;
    if (!item) return null;
    if (item.url && FAL_FETCHABLE_HOST_RE.test(item.url)) return item.url;
    if (typeof item.getDataUrl === 'function') {
      try {
        return await item.getDataUrl();
      } catch {
        /* fall through */
      }
    }
    return item.url ?? null;
  } catch (e) {
    console.warn('[boardHelpers] getImageUrl failed', e);
    return null;
  }
}

/**
 * A URL safe to read PIXELS from — the mirror image of `getImageUrl`.
 *
 * `getImageUrl` prefers the hosted fal.media URL because its callers send it
 * *to Fal*, where a URL beats a multi-MB base64 body. Local pixel work wants
 * the exact opposite: a cross-origin image taints the canvas (or, with
 * `crossOrigin="anonymous"` and no `Access-Control-Allow-Origin` from that
 * host, refuses to load at all), so `getDataUrl()`'s `data:` URI — same-origin
 * by definition — comes first here. That keeps canvas apps like Pattern Fill
 * working with no backend at all, instead of bouncing off `/proxy`.
 */
export async function getImagePixelRef(
  itemId: string,
): Promise<{ miroImageId: string; url: string; title?: string } | null> {
  try {
    const item = (await miro.board.getById(itemId)) as MiroImageItem;
    if (!item) return null;
    const title = (item.title ?? '').trim() || undefined;
    if (typeof item.getDataUrl === 'function') {
      try {
        const dataUrl = await item.getDataUrl();
        if (dataUrl) return { miroImageId: itemId, url: dataUrl, title };
      } catch (e) {
        console.warn('[boardHelpers] getDataUrl failed, falling back to the hosted URL', e);
      }
    }
    return item.url ? { miroImageId: itemId, url: item.url, title } : null;
  } catch (e) {
    console.warn('[boardHelpers] getImagePixelRef failed', e);
    return null;
  }
}

/**
 * Resolve an item's BOARD-ABSOLUTE centre and size, walking the parent chain.
 * Items inside a frame store x/y relative to the frame's top-left, so we must
 * accumulate parent offsets before passing coordinates to createImage.
 */
export type AbsolutePosition = {
  absoluteX: number;
  absoluteY: number;
  width: number;
  height: number;
  ownX: number;
  ownY: number;
  parentId?: string;
  type?: string;
};

export async function resolveAbsolutePosition(
  itemId: string,
): Promise<AbsolutePosition | null> {
  type Resolvable = {
    type?: string;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    parentId?: string;
  };

  // getById throws (rather than returning null) for an id that is no longer
  // on the board — e.g. a placeholder another finalize already swapped out.
  // A missing item is a normal answer here, not an error.
  let item: Resolvable | null;
  try {
    item = (await miro.board.getById(itemId)) as Resolvable | null;
  } catch {
    return null;
  }
  if (!item) return null;

  const ownX = item.x ?? 0;
  const ownY = item.y ?? 0;
  const width = item.width ?? 0;
  const height = item.height ?? 0;

  let absX = ownX;
  let absY = ownY;
  let walkParentId = item.parentId;
  let depth = 0;

  while (walkParentId && depth < 20) {
    const parent = (await miro.board.getById(walkParentId)) as Resolvable | null;
    if (!parent) break;
    const px = parent.x ?? 0;
    const py = parent.y ?? 0;
    const pw = parent.width ?? 0;
    const ph = parent.height ?? 0;
    absX += px - pw / 2;
    absY += py - ph / 2;
    walkParentId = parent.parentId;
    depth += 1;
  }

  return { absoluteX: absX, absoluteY: absY, width, height, ownX, ownY, parentId: item.parentId, type: item.type };
}

/** A settings card's parent frame id, or null if it has none. */
export async function getParentFrameId(itemId: string): Promise<string | null> {
  const item = (await miro.board.getById(itemId).catch(() => null)) as { parentId?: string } | null;
  return item?.parentId ?? null;
}

// The "logical" aspect ratios models offer (see SIZE_TO_RATIO in
// ReferenceToVideoScreen) — used to snap a reference frame's own shape to one
// of these when it's close, instead of trusting an arbitrary grouping frame's
// exact proportions.
const KNOWN_RATIOS: Array<{ ratio: string; value: number }> = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'].map(
  (ratio) => {
    const [w, h] = ratio.split(':').map(Number);
    return { ratio, value: w / h };
  },
);

/**
 * Snap a frame's own width/height to the nearest logical aspect ratio (16:9,
 * 9:16, 1:1, …) if it's within `tolerance` (4% by default) — lets a frame
 * shaped roughly like a target video/image format drive the output's ratio
 * automatically. Returns null for an oddly-shaped grouping frame, so the
 * caller falls back to its own ratio logic.
 */
export function snapFrameRatio(width: number, height: number, tolerance = 0.04): string | null {
  if (!width || !height) return null;
  const value = width / height;
  let best: { ratio: string; diff: number } | null = null;
  for (const k of KNOWN_RATIOS) {
    const diff = Math.abs(k.value - value) / k.value;
    if (!best || diff < best.diff) best = { ratio: k.ratio, diff };
  }
  return best && best.diff <= tolerance ? best.ratio : null;
}

/**
 * The absolute (x, y, width, height) box directly below `frameId`, sized to
 * match the frame's own width, at the given ratio (typically the frame's own
 * `snapFrameRatio`, falling back to the caller's usual ratio). Used when a
 * generation's references came from a frame, so the output visually belongs
 * with the frame instead of trailing off one reference item inside it.
 */
export async function resolveBelowFrameBox(
  frameId: string,
  ratio: string,
): Promise<{ x: number; y: number; width: number; height: number } | null> {
  const frame = await resolveAbsolutePosition(frameId);
  if (!frame || !frame.width || !frame.height) return null;
  const [rw, rh] = ratio.split(':').map((n) => parseInt(n, 10));
  const width = frame.width;
  const height = rw && rh ? Math.round(width * (rh / rw)) : width;
  const gap = 80;
  return {
    x: frame.absoluteX,
    y: frame.absoluteY + frame.height / 2 + gap + height / 2,
    width,
    height,
  };
}

/**
 * Place a new image directly BELOW (or, for a settings-card anchor, to the
 * RIGHT of) a source item. Falls back to the viewport centre when the source
 * can't be resolved. `siblingOffsetIndex` shifts along the placement axis so
 * parallel generations don't stack.
 */
export async function createImageBelow(opts: {
  sourceItemId?: string;
  url: string;
  ratio: string;
  title?: string;
  siblingOffsetIndex?: number;
  side?: 'below' | 'right';
}): Promise<{ id: string; x: number; y: number }> {
  const { sourceItemId, url, ratio, title, siblingOffsetIndex = 0, side = 'below' } = opts;
  const { width: imgWidth, height: imgHeight } = parseRatio(ratio, 720);

  let requestedX = 0;
  let requestedY = 0;

  try {
    const src = sourceItemId ? await resolveAbsolutePosition(sourceItemId) : null;
    if (src) {
      const gap = 80;
      if (side === 'right') {
        requestedX = src.absoluteX + src.width / 2 + gap + imgWidth / 2;
        requestedY = src.absoluteY + siblingOffsetIndex * (imgHeight + 40);
      } else {
        requestedX = src.absoluteX + siblingOffsetIndex * (imgWidth + 40);
        requestedY = src.absoluteY + src.height / 2 + gap + imgHeight / 2;
      }
    } else {
      const vp = await miro.board.viewport.get();
      requestedX = vp.x + vp.width / 2;
      requestedY = vp.y + vp.height / 2;
    }
  } catch (err) {
    console.warn('[createImageBelow] source lookup threw:', err);
  }

  // createImage rejects width + height together — pass width only; Miro infers
  // height from the asset. x/y are board-absolute.
  const img = (await miro.board.createImage({
    url,
    title: title ?? 'Fal generation',
    x: requestedX,
    y: requestedY,
    width: imgWidth,
  })) as { id: string; x?: number; y?: number };

  const actualX = typeof img.x === 'number' ? img.x : requestedX;
  const actualY = typeof img.y === 'number' ? img.y : requestedY;
  return { id: img.id, x: actualX, y: actualY };
}

/**
 * Place a new Card directly BELOW a source item, centered on its x — same
 * placement rule as `createImageBelow`, for the "Save as settings card" flow.
 * Cards auto-size their height to content, so (unlike images) there's no
 * ratio to reserve space for; `gap` just clears the source's own box.
 */
export async function createCardBelow(opts: {
  sourceItemId?: string;
  title: string;
  description: string;
  width?: number;
}): Promise<{ id: string; x: number; y: number }> {
  const { sourceItemId, title, description, width = 320 } = opts;

  let requestedX = 0;
  let requestedY = 0;

  try {
    const src = sourceItemId ? await resolveAbsolutePosition(sourceItemId) : null;
    if (src) {
      const gap = 80;
      requestedX = src.absoluteX;
      requestedY = src.absoluteY + src.height / 2 + gap + 60;
    } else {
      const vp = await miro.board.viewport.get();
      requestedX = vp.x + vp.width / 2;
      requestedY = vp.y + vp.height / 2;
    }
  } catch (err) {
    console.warn('[createCardBelow] source lookup threw:', err);
  }

  const card = await miro.board.createCard({
    title,
    description,
    x: requestedX,
    y: requestedY,
    width,
  });

  const actualX = typeof card.x === 'number' ? card.x : requestedX;
  const actualY = typeof card.y === 'number' ? card.y : requestedY;
  return { id: card.id, x: actualX, y: actualY };
}

/**
 * Create a settings Card as a child of `frameId` — the "prompt frame" model:
 * the card and its references live in the same frame, so nothing needs
 * connecting (see `getFrameCardResources`). Placed near the frame's
 * bottom-left corner, since items inside a frame position relative to its
 * top-left (see `resolveAbsolutePosition`).
 */
export async function createCardInFrame(opts: {
  frameId: string;
  title: string;
  description: string;
  width?: number;
}): Promise<{ id: string; x: number; y: number }> {
  const { frameId, title, description, width = 320 } = opts;
  const frame = (await miro.board.getById(frameId)) as { height?: number };
  const fh = frame.height ?? 600;
  const margin = 24;
  const cardHeight = 60; // cards auto-size, but this is a close-enough estimate for corner placement

  const card = await miro.board.createCard({ title, description, width });
  await (frame as unknown as { add: (item: unknown) => Promise<void> }).add(card);

  card.x = width / 2 + margin;
  card.y = fh - cardHeight / 2 - margin;
  await card.sync();

  return { id: card.id, x: card.x, y: card.y };
}

/**
 * Best-effort connectors from each board item to a card — used so a saved
 * settings card stays wired to whatever it was created from (the same images/
 * video/prompt sticky the generation used), ready to detect on a future
 * reopen. One bad id doesn't block the rest. Every connector lands on the
 * card's left side — inputs in on the left, output placed to the right (see
 * `resolvePlaceholderAnchor`), so the card reads as a left-to-right block.
 */
export async function connectItemsToCard(itemIds: string[], cardId: string): Promise<void> {
  for (const id of itemIds) {
    try {
      await miro.board.createConnector({
        shape: 'curved',
        start: { item: id },
        end: { item: cardId, snapTo: 'left' },
      });
    } catch (e) {
      console.warn('[connectItemsToCard] failed to connect', id, 'to', cardId, e);
    }
  }
}

/**
 * Create an image at a board-absolute (x, y) centre with a given width. Used by
 * "capture the current view" flows (video-frame / 3D-viewer → image), which
 * compute an exact placement rather than "below a source".
 */
export async function createImageAtAbsolute(opts: {
  url: string;
  x: number;
  y: number;
  width: number;
  title?: string;
}): Promise<{ id: string; x: number; y: number }> {
  const { url, x, y, width, title } = opts;
  const img = (await miro.board.createImage({
    url,
    title: title ?? 'Fal capture',
    x,
    y,
    width,
  })) as { id: string; x?: number; y?: number };
  return { id: img.id, x: img.x ?? x, y: img.y ?? y };
}

/**
 * Return a URL only if it's a public http(s) URL (not a data: URI) — a Miro
 * embed `previewUrl` must be a fetchable image URL, and board data URIs can be
 * multi-MB, so we skip those.
 */
export function asPreviewUrl(u: string | null | undefined): string | undefined {
  return typeof u === 'string' && /^https?:\/\//i.test(u) ? u : undefined;
}

/**
 * Create an inline embed widget at a board-absolute position. Used for finished
 * video generations — Miro has no native video item, but its embed widget
 * accepts any iframable URL (our /embed/video player page).
 */
export async function createEmbedAtPosition(opts: {
  url: string;
  x: number;
  y: number;
  width: number;
  height: number;
  previewUrl?: string;
}): Promise<{ id: string; x: number; y: number }> {
  const { url, x, y, width, height, previewUrl } = opts;
  const createEmbed = (miro.board as unknown as {
    createEmbed: (o: Record<string, unknown>) => Promise<{ id: string; x?: number; y?: number }>;
  }).createEmbed;

  const embed = await createEmbed({
    url,
    mode: 'inline',
    width,
    height,
    x,
    y,
    ...(previewUrl ? { previewUrl } : {}),
  });
  return { id: embed.id, x: embed.x ?? x, y: embed.y ?? y };
}

/** Delete an item from the board by id. Safe if the item is already gone. */
export async function deleteItem(id: string): Promise<void> {
  try {
    const item = (await miro.board.getById(id)) as { id: string } | null;
    if (!item) return;
    await (miro.board as unknown as { remove: (item: unknown) => Promise<void> }).remove(item);
  } catch (e) {
    console.warn('[deleteItem]', id, e);
  }
}

/**
 * Replace the image rendered at `imageId` with `newUrl`.
 *
 * The placeholder stays wherever it is *now* — if the user dragged it somewhere
 * else while the job was running, the finished image lands there, not back at
 * its original spot. We snapshot the current (x, y) and re-assert it after the
 * URL swap, since changing the URL can make Miro re-anchor the item.
 * `fallbackPosition` is only used if the item somehow has no coordinates.
 */
export async function replaceImageContent(
  imageId: string,
  newUrl: string,
  newTitle?: string,
  fallbackPosition?: { x: number; y: number },
): Promise<void> {
  const item = (await miro.board.getById(imageId)) as {
    url?: string;
    title?: string;
    x?: number;
    y?: number;
    sync?: () => Promise<void>;
  } | null;
  if (!item) throw new Error(`Image ${imageId} not found`);

  // Where the placeholder is right now (honours any manual move).
  const keepX = item.x ?? fallbackPosition?.x;
  const keepY = item.y ?? fallbackPosition?.y;

  item.url = newUrl;
  if (newTitle) item.title = newTitle;

  if (typeof keepX === 'number' && typeof keepY === 'number') {
    item.x = keepX;
    item.y = keepY;
  }

  if (typeof item.sync === 'function') await item.sync();
}
