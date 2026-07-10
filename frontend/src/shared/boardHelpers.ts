// Thin wrappers around the Miro Web SDK shared across agents. Adapted from the
// Runway integration, trimmed to what the Fal image agent needs.

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

export async function cachedBoardGet(type: string): Promise<unknown[]> {
  const hit = boardQueryCache.get(type);
  if (hit && Date.now() - hit.at < BOARD_QUERY_TTL_MS) return hit.p;
  const get = miro.board.get as unknown as (o: { type: string }) => Promise<unknown[]>;
  const p = get({ type }).catch((e) => {
    boardQueryCache.delete(type); // don't cache a failed query
    throw e;
  });
  boardQueryCache.set(type, { at: Date.now(), p });
  return p;
}

/** Ratio string "W:H" → numeric { width, height } at a reasonable display size. */
export function parseRatio(ratio: string, maxDim = 720): { width: number; height: number } {
  const [w, h] = ratio.split(':').map((n) => parseInt(n, 10));
  if (!w || !h) return { width: maxDim, height: maxDim };
  const scale = maxDim / Math.max(w, h);
  return { width: Math.round(w * scale), height: Math.round(h * scale) };
}

/** A tiny inline SVG placeholder data-URI sized to the requested ratio. */
export function makePlaceholderDataUrl(ratio: string, label = 'Generating…'): string {
  const { width, height } = parseRatio(ratio, 1024);
  // Dark card matching the redesign: near-black fill, hairline border, yellow
  // label, and a thin accent bar suggesting progress.
  const min = Math.min(width, height);
  const barW = Math.round(width * 0.4);
  const barX = Math.round((width - barW) / 2);
  const barY = Math.round(height * 0.62);
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" rx="14" fill="#141417"/>
  <rect x="1" y="1" width="${width - 2}" height="${height - 2}" rx="13" fill="none" stroke="#FFDD33" stroke-opacity="0.35" stroke-width="2"/>
  <g font-family="'Roobert PRO', system-ui, sans-serif" text-anchor="middle">
    <text x="50%" y="46%" fill="#FFDD33" font-size="${Math.round(min / 16)}" font-weight="700">${label}</text>
    <text x="50%" y="53%" fill="#8a8a92" font-size="${Math.round(min / 30)}">${width} × ${height}</text>
  </g>
  <rect x="${barX}" y="${barY}" width="${barW}" height="4" rx="2" fill="#FFDD33" fill-opacity="0.5"/>
</svg>`;
  // btoa is Latin1-only; the default label contains "…" (U+2026) so UTF-8 encode first.
  const bytes = new TextEncoder().encode(svg);
  const binary = String.fromCharCode(...bytes);
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}

/** Strip HTML tags from sticky-note content (Miro stores it as `<p>…</p>`). */
export function stripHtml(html: string): string {
  if (!html) return '';
  const d = document.createElement('div');
  d.innerHTML = html;
  return (d.textContent ?? d.innerText ?? '').replace(/\s+/g, ' ').trim();
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

/**
 * Resolve image items connected to a sticky note via board connectors. Fal
 * image-to-image / edit models take these as `image_url` inputs.
 */
export async function getConnectedReferenceImages(
  stickyId: string,
): Promise<Array<{ miroImageId: string; url?: string; title?: string }>> {
  const connectors = await cachedBoardGet('connector');
  const partners = new Set<string>();
  for (const c of connectors as Array<{ start?: { item?: string }; end?: { item?: string } }>) {
    const s = c.start?.item;
    const e = c.end?.item;
    if (!s || !e) continue;
    if (s === stickyId) partners.add(e);
    else if (e === stickyId) partners.add(s);
  }

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
  const connectors = await cachedBoardGet('connector');
  const partners = new Set<string>();
  for (const c of connectors as Array<{ start?: { item?: string }; end?: { item?: string } }>) {
    const s = c.start?.item;
    const e = c.end?.item;
    if (!s || !e) continue;
    if (s === itemId) partners.add(e);
    else if (e === itemId) partners.add(s);
  }
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

  const item = (await miro.board.getById(itemId)) as Resolvable | null;
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

/**
 * Place a new image directly BELOW a source item, centered on its x. Falls back
 * to the viewport centre when the source can't be resolved. `siblingOffsetIndex`
 * shifts horizontally so parallel generations don't stack.
 */
export async function createImageBelow(opts: {
  sourceItemId?: string;
  url: string;
  ratio: string;
  title?: string;
  siblingOffsetIndex?: number;
}): Promise<{ id: string; x: number; y: number }> {
  const { sourceItemId, url, ratio, title, siblingOffsetIndex = 0 } = opts;
  const { width: imgWidth, height: imgHeight } = parseRatio(ratio, 720);

  let requestedX = 0;
  let requestedY = 0;

  try {
    const src = sourceItemId ? await resolveAbsolutePosition(sourceItemId) : null;
    if (src) {
      const gap = 80;
      requestedX = src.absoluteX + siblingOffsetIndex * (imgWidth + 40);
      requestedY = src.absoluteY + src.height / 2 + gap + imgHeight / 2;
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
