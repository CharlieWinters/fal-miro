// Bria Ad Delayer → native Miro items.
//
// The model takes a flat ad image and returns no image at all: it returns the
// ad's *structure* — a canvas size plus a z-ordered list of layers, each with a
// bounding box, and either an extracted cutout URL, live text with typography,
// or a fill colour. So the useful thing to put on the board is not a picture of
// the ad, it is the ad rebuilt out of board items you can actually edit:
// cutouts as images, copy as Miro text, flat fills as shapes, assembled in
// their original relative positions directly below the ad they came from.
//
// Deliberately no frame around it. The layers are ordinary board items, so they
// can be dragged, retyped and restyled without entering anything first — and
// Miro frames turned out to accept neither metadata nor a description (both
// refused live), so a frame would also have had nowhere to record what made it.
//
// Shared by the live agent and resume_jobs' boot sweep, which both need to turn
// the same payload into the same items (see ARCHITECTURE.md, "Results that are
// not media").
import type { FontFamily, TextAlign } from '@mirohq/websdk-types';
import { deleteItem } from './boardHelpers';
import { setItemGenerationSettings, type GenSettings } from './storage';
import { estimateCostUSD } from './cost';

export type AdBBox = { x: number; y: number; width: number; height: number };

export type AdTextStyle = {
  color?: string;
  font_family?: string;
  font_weight?: number;
  font_size_px?: number;
  letter_spacing_px?: number;
  text_align?: string;
  uppercase?: boolean;
  italic?: boolean;
  line_height?: number;
};

export type AdLayer = {
  id: string;
  type: 'image' | 'text' | 'vector' | string;
  subtype?: string;
  z_order?: number;
  bbox?: AdBBox;
  /** Images: the extracted cutout (png) or traced copy (svg). */
  asset_path?: string;
  /** Text: the copy itself, newline-separated. */
  text?: string;
  text_style?: AdTextStyle;
  /** Vectors: a flat fill, including the ad's own backdrop. */
  style?: { background_color?: string; fill?: string; color?: string };
  /** Set on the layer the model superseded — in `font` mode every text layer
   *  also comes back as a traced SVG twin, flagged hidden. */
  hidden?: boolean;
};

export type AdLayersResult = {
  canvas?: { width?: number; height?: number };
  layers?: AdLayer[];
  /** Google Fonts links for the typography. Not loadable into Miro text, so
   *  they are reported rather than used. */
  font_stylesheets?: string[];
};

/** Width of the rebuilt ad when the source's own board width is unknown. The
 *  app's generated images are 720 wide, so this matches its other output. */
export const AD_DEFAULT_WIDTH = 720;

/**
 * The board width an ad job was set up for, read back from the "W:H" the agent
 * stored as the job's ratio. Not `parseRatio`, which rescales a ratio to fit a
 * box rather than returning the width it was given.
 */
export function targetWidthFromRatio(ratio: string | undefined): number {
  const w = Number((ratio ?? '').split(':')[0]);
  return Number.isFinite(w) && w > 0 ? w : AD_DEFAULT_WIDTH;
}

export function isAdLayersResult(data: unknown): data is AdLayersResult {
  if (!data || typeof data !== 'object') return false;
  const d = data as AdLayersResult;
  return Array.isArray(d.layers) && Boolean(d.canvas);
}

/** Miro has a fixed font list, so each CSS stack maps to its nearest relative.
 *  Order matters: the first entry that appears in the stack wins. */
const FONT_MATCHES: Array<[RegExp, FontFamily]> = [
  [/cormorant|garamond|eb garamond/i, 'eb_garamond'],
  [/cinzel|playfair|trajan/i, 'eb_garamond'],
  [/times|tiempos/i, 'times_new_roman'],
  [/georgia/i, 'georgia'],
  [/pt serif|noto serif|source serif|merriweather|lora/i, 'pt_serif'],
  [/montserrat|poppins|futura|avenir|proxima|gotham|helvetica|inter|nunito/i, 'open_sans'],
  [/roboto slab/i, 'roboto_slab'],
  [/roboto condensed|oswald|barlow condensed/i, 'roboto_condensed'],
  [/roboto|arial|open sans|lato|work sans|dm sans|noto sans/i, 'roboto'],
  [/courier|mono/i, 'roboto_mono'],
  [/caveat|handwrit|script|pacifico|dancing/i, 'caveat'],
  [/marker|permanent/i, 'permanent_marker'],
];

export function miroFontFor(cssFamily: string | undefined): FontFamily {
  const stack = cssFamily ?? '';
  for (const [re, font] of FONT_MATCHES) if (re.test(stack)) return font;
  return /serif/i.test(stack) && !/sans-serif/i.test(stack) ? 'pt_serif' : 'open_sans';
}

export function miroTextAlign(align: string | undefined): TextAlign {
  return align === 'center' || align === 'right' ? align : 'left';
}

/** `#RGB`/`#RRGGBB` only — anything else (a gradient, `rgba()`, a keyword) is
 *  left to the caller to skip rather than guessed at. */
export function normalizeHexColor(value: string | undefined): string | null {
  const v = (value ?? '').trim();
  if (/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(v)) return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`.toLowerCase();
  return null;
}

export type AdPlan = {
  /** The whole assembly's size in board units. */
  size: { width: number; height: number };
  /** canvas px → board units. */
  scale: number;
  /** Layers to build, back to front — creation order is the stacking order, so
   *  `z_order` needs nothing else. Positions are board units relative to the
   *  assembly's centre. */
  items: AdPlanItem[];
  /** Layers deliberately left out, with the reason — reported rather than
   *  dropped silently, so a missing piece of the ad is always explained. */
  skipped: Array<{ id: string; reason: string }>;
  fontStylesheets: string[];
};

export type AdPlanItem = { id: string; dx: number; dy: number; width: number; height: number } & (
  | { kind: 'image'; url: string; title: string }
  | { kind: 'text'; content: string; fontSize: number; color: string; align: TextAlign; font: FontFamily }
  | { kind: 'shape'; fillColor: string }
);

/**
 * Turn a result into an ordered build plan, scaled so the assembly is
 * `targetWidth` wide. Pure, so the geometry and the font/colour decisions are
 * testable without a board.
 */
export function planAdLayers(result: AdLayersResult, targetWidth = AD_DEFAULT_WIDTH): AdPlan {
  const cw = Math.max(1, result.canvas?.width ?? 0);
  const ch = Math.max(1, result.canvas?.height ?? 0);
  const scale = targetWidth / cw;
  const width = Math.round(cw * scale);
  const height = Math.round(ch * scale);
  const skipped: Array<{ id: string; reason: string }> = [];
  const items: AdPlanItem[] = [];

  for (const layer of [...(result.layers ?? [])].sort((a, b) => (a.z_order ?? 0) - (b.z_order ?? 0))) {
    if (layer.hidden) {
      skipped.push({ id: layer.id, reason: 'the model marked it hidden' });
      continue;
    }
    const box = layer.bbox;
    if (!box || !(box.width > 0) || !(box.height > 0)) {
      skipped.push({ id: layer.id, reason: 'no usable bounding box' });
      continue;
    }
    // Board items are positioned by their centre; a bbox is a top-left corner.
    const geom = {
      id: layer.id,
      dx: (box.x + box.width / 2) * scale - width / 2,
      dy: (box.y + box.height / 2) * scale - height / 2,
      width: box.width * scale,
      height: box.height * scale,
    };

    if (layer.type === 'image') {
      if (!layer.asset_path) {
        skipped.push({ id: layer.id, reason: 'no asset URL' });
        continue;
      }
      items.push({ ...geom, kind: 'image', url: layer.asset_path, title: layer.subtype ?? layer.id });
    } else if (layer.type === 'text') {
      const content = (layer.text ?? '').trim();
      if (!content) {
        skipped.push({ id: layer.id, reason: 'no text' });
        continue;
      }
      const ts = layer.text_style ?? {};
      items.push({
        ...geom,
        kind: 'text',
        content: ts.uppercase ? content.toUpperCase() : content,
        fontSize: Math.max(8, Math.round((ts.font_size_px ?? 14) * scale)),
        color: normalizeHexColor(ts.color) ?? '#1a1a1a',
        align: miroTextAlign(ts.text_align),
        font: miroFontFor(ts.font_family),
      });
    } else if (layer.type === 'vector') {
      // The ad's backdrop is just the backmost rectangle, nothing special.
      const fill = normalizeHexColor(layer.style?.background_color ?? layer.style?.fill ?? layer.style?.color);
      if (!fill) {
        skipped.push({ id: layer.id, reason: 'no flat fill colour to copy' });
        continue;
      }
      items.push({ ...geom, kind: 'shape', fillColor: fill });
    } else {
      skipped.push({ id: layer.id, reason: `unsupported layer type "${layer.type}"` });
    }
  }

  return { size: { width, height }, scale, items, skipped, fontStylesheets: result.font_stylesheets ?? [] };
}

/** A one-line tally of what the plan will build. */
export function describePlan(plan: AdPlan): string {
  const counts = plan.items.reduce<Record<string, number>>((acc, i) => {
    acc[i.kind] = (acc[i.kind] ?? 0) + 1;
    return acc;
  }, {});
  const parts = (['image', 'text', 'shape'] as const)
    .filter((k) => counts[k])
    .map((k) => `${counts[k]} ${k}${counts[k] === 1 ? '' : 's'}`);
  return parts.join(', ') || 'nothing usable';
}

// ---------------------------------------------------------------------------
// Board side. Kept in this module with the plan it consumes, the way
// genericOutput.ts pairs classification with placement.
// ---------------------------------------------------------------------------

export type BuiltAd = { itemIds: string[]; built: number; skipped: number };

/**
 * Build a planned ad centred on an absolute board position, back to front.
 * Creation order is the stacking order, so the ad reads correctly without any
 * z-index handling of its own.
 */
export async function buildAdLayers(opts: {
  plan: AdPlan;
  x: number;
  y: number;
  titlePrefix: string;
}): Promise<BuiltAd> {
  const { plan, x, y, titlePrefix } = opts;
  const board = miro.board as unknown as {
    createImage: (p: Record<string, unknown>) => Promise<{ id: string }>;
    createText: (p: Record<string, unknown>) => Promise<{ id: string }>;
    createShape: (p: Record<string, unknown>) => Promise<{ id: string }>;
  };

  const itemIds: string[] = [];
  for (const item of plan.items) {
    const ix = x + item.dx;
    const iy = y + item.dy;
    let created: { id: string };
    if (item.kind === 'image') {
      created = await board.createImage({
        url: item.url,
        x: ix,
        y: iy,
        width: item.width,
        title: `${titlePrefix} · ${item.title}`,
      });
    } else if (item.kind === 'text') {
      created = await board.createText({
        // Miro text content is HTML, so the model's newlines have to become
        // markup or they collapse into single spaces.
        content: item.content.replace(/\n/g, '<br>'),
        x: ix,
        y: iy,
        width: item.width,
        style: { color: item.color, fontSize: item.fontSize, textAlign: item.align, fontFamily: item.font },
      });
    } else {
      created = await board.createShape({
        shape: 'rectangle',
        x: ix,
        y: iy,
        width: item.width,
        height: item.height,
        style: { fillColor: item.fillColor, borderWidth: 0 },
      });
    }
    itemIds.push(created.id);
  }
  return { itemIds, built: itemIds.length, skipped: plan.skipped.length };
}

export type BuiltAdRecord = BuiltAd & {
  /** The item carrying the generation metadata. */
  recordedOn?: string;
  summary: string;
  notes: string[];
};

/**
 * Rebuild an ad from a raw model result, replacing its placeholder and
 * recording what produced it. In the hull because two agents run it:
 * fal_ad_layers on the live path, and resume_jobs when the board was reloaded
 * mid-generation — the same reason advancePipelineForJob lives here.
 */
export async function buildAdLayersFromResult(opts: {
  data: unknown;
  settings: GenSettings;
  endpointId: string;
  placeholderId: string;
  /** Board width to match — the source ad's, so the rebuild sits beneath it at
   *  the same size and reads as a before and after. */
  targetWidth: number;
  sourceTitle?: string;
  sourceImageId?: string;
  x: number;
  y: number;
}): Promise<BuiltAdRecord> {
  const { data, settings, endpointId, placeholderId, targetWidth, sourceTitle, sourceImageId, x, y } = opts;
  if (!isAdLayersResult(data)) throw new Error('The model returned no layers.');
  const plan = planAdLayers(data, targetWidth);
  const titlePrefix = sourceTitle?.trim() ? `${sourceTitle.trim()} layer` : 'Ad layer';

  // Delete the placeholder first so the layers land on a clear spot.
  await deleteItem(placeholderId);
  const result = await buildAdLayers({ plan, x, y, titlePrefix });

  // The record of what produced this goes on the backmost layer: one item, so
  // the cost is counted once however many layers the ad had, and the assembly
  // still traces back to the source image.
  const recordedOn = result.itemIds[0];
  if (recordedOn) {
    await setItemGenerationSettings(recordedOn, {
      ...settings,
      costUSD: await estimateCostUSD(endpointId, { units: 1 }),
      ...(sourceImageId ? { parents: [sourceImageId] } : {}),
    });
  }
  return {
    ...result,
    recordedOn,
    summary: describePlan(plan),
    notes: [
      ...plan.skipped.map((s) => `Skipped ${s.id}: ${s.reason}`),
      ...(plan.fontStylesheets.length ? [`Original fonts: ${plan.fontStylesheets.join(' ')}`] : []),
    ],
  };
}
