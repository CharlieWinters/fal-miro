// Pattern Fill — the compositing pipeline, ported from the standalone
// pattern-fill-miro-app (`agents/pattern_fill_agent/headless/logic.ts`).
//
// **Nothing here calls a model.** The original's only backend dependency was
// the mask (Nova Canvas `BackgroundRemoval`); this port gets its mask either
// from the flat itself (see ./autoMask.ts) or from a mask image already on the
// board — which is what fal-miro's Create Mask app produces — so pattern fill
// costs nothing and works with no backend configured.
//
// The original ran five sequential full-image passes over separate canvases
// (transparent layer → pattern layer → applied mask → 3-step composite →
// keep-mask). This is one pass with the same formulas, because the layers only
// ever combine per-pixel. Two things fell out of writing the algebra down:
//
//   * The original's "composite step 3" (compositing the multiply result over
//     the transparent layer) is a no-op whenever the pattern layer is opaque,
//     which it always is for a solid colour or an opaque pattern — step 2's
//     alpha is already 255, so the blend resolves to step 2 exactly. It's kept
//     below for patterns that *do* carry transparency, where it still matters.
//   * "Multiply mode" is what makes a garment's line art and shading survive
//     the fill: the flat's own greys multiply into the pattern instead of
//     being painted over. Anti-aliased line edges stay soft because the
//     multiply is weighted by the pixel's own colour, even though the
//     ink/background split itself is a hard threshold (as in the original).

/** Anything at or above this on all three channels counts as background. */
export const DEFAULT_WHITE_THRESHOLD = 240;

export type FillSource =
  | { kind: 'pattern'; url: string; tileSize: number }
  | { kind: 'color'; color: string };

export type PatternFillOptions = {
  /** The garment flat — line art on a white ground. */
  garmentUrl: string;
  fill: FillSource;
  /** White = fill here. Omitted → derive one from the flat (autoMask). */
  maskUrl?: string;
  invertMask?: boolean;
  /** Let the flat's lines/shading show through the fill. Default true. */
  multiply?: boolean;
  /** Drop the white ground, keeping only the garment. Default true. */
  removeBackground?: boolean;
  whiteThreshold?: number;
};

/**
 * Load an image for pixel work.
 *
 * Board images normally arrive here as a `data:` URI (`getImagePixelRef`),
 * which needs no CORS and always works offline. A hosted URL only turns up
 * when Miro couldn't hand over the bytes; that may load cleanly (fal's CDN
 * sends `Access-Control-Allow-Origin`) or may be blocked, so the last resort
 * is the backend `/proxy` — the same escape hatch the capture tools use, and
 * the only path here that needs a backend at all.
 */
export async function loadPixelImage(
  url: string,
  viaProxy?: (u: string) => string,
): Promise<HTMLImageElement> {
  const attempt = (src: string, crossOrigin: boolean) =>
    new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      if (crossOrigin) img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(src.slice(0, 80)));
      img.src = src;
    });

  const isData = url.startsWith('data:');
  try {
    return await attempt(url, !isData);
  } catch (e) {
    if (isData) throw new Error('That image’s data was unreadable.');
    if (!viaProxy) throw e;
    try {
      return await attempt(viaProxy(url), true);
    } catch {
      // Both paths are gone: the host blocked a direct read and the proxy
      // didn't answer. Say which knob fixes it rather than echoing a URL.
      throw new Error(
        "That image is hosted somewhere this browser can't read pixels from, and the backend " +
          "proxy didn't respond. Check the backend in Settings, or re-add the image to the board " +
          'so Miro serves it directly.',
      );
    }
  }
}

function ctxOf(width: number, height: number): CanvasRenderingContext2D {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Could not get a 2D canvas context');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  return ctx;
}

/** Draw an image at its natural size and read it back. */
export function imageDataOf(img: HTMLImageElement): ImageData {
  const ctx = ctxOf(img.naturalWidth, img.naturalHeight);
  ctx.drawImage(img, 0, 0);
  return ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height);
}

/**
 * The fill layer at garment size: a solid colour, or the pattern tiled at
 * `tileSize` px wide (aspect preserved). A pattern already bigger than the
 * garment is scaled to cover and centred instead of tiled — same rule as the
 * original.
 *
 * Tiling deliberately runs with smoothing OFF and integer tile positions:
 * interpolated tile edges leave visible seams between tiles.
 */
export function buildFillLayer(
  fill: FillSource,
  patternImg: HTMLImageElement | null,
  width: number,
  height: number,
): ImageData {
  const ctx = ctxOf(width, height);

  if (fill.kind === 'color' || !patternImg) {
    ctx.fillStyle = fill.kind === 'color' ? fill.color : '#ffffff';
    ctx.fillRect(0, 0, width, height);
    return ctx.getImageData(0, 0, width, height);
  }

  const pw = patternImg.naturalWidth;
  const ph = patternImg.naturalHeight;
  const tileW = Math.max(2, Math.round(fill.tileSize));
  const tileH = Math.max(2, Math.round(tileW * (ph / pw)));

  if (tileW < width || tileH < height) {
    const tile = ctxOf(tileW, tileH);
    tile.imageSmoothingEnabled = false;
    tile.drawImage(patternImg, 0, 0, tileW, tileH);
    ctx.imageSmoothingEnabled = false;
    for (let y = 0; y < height; y += tileH) {
      for (let x = 0; x < width; x += tileW) {
        ctx.drawImage(tile.canvas, x, y);
      }
    }
  } else {
    const scale = Math.max(width / pw, height / ph);
    const w = pw * scale;
    const h = ph * scale;
    ctx.drawImage(patternImg, (width - w) / 2, (height - h) / 2, w, h);
  }
  return ctx.getImageData(0, 0, width, height);
}

/** Resample a mask image to the garment's pixel grid. */
export function buildMaskLayer(maskImg: HTMLImageElement, width: number, height: number): ImageData {
  const ctx = ctxOf(width, height);
  ctx.drawImage(maskImg, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height);
}

/**
 * Composite the fill into the garment through the mask.
 *
 * `mask` carries the fill region in its red channel (255 = fill here). The
 * per-pixel algebra mirrors the original's four stages:
 *
 *   ink       = the flat minus its white ground (alpha 0 on background)
 *   applied   = the flat, made transparent *inside* the mask
 *   step1     = fill under `applied`  → pattern inside the mask, flat outside
 *   step2     = step1 multiplied by the ink, weighted by ink alpha
 *   step3     = step2 over the ink layer (only bites for translucent patterns)
 */
export function composite(
  garment: ImageData,
  fillLayer: ImageData,
  mask: Uint8ClampedArray | Uint8Array,
  opts: { multiply: boolean; removeBackground: boolean; whiteThreshold: number },
): ImageData {
  const { multiply, removeBackground, whiteThreshold } = opts;
  const g = garment.data;
  const f = fillLayer.data;
  const out = new ImageData(garment.width, garment.height);
  const o = out.data;

  for (let i = 0; i < g.length; i += 4) {
    const gr = g[i];
    const gg = g[i + 1];
    const gb = g[i + 2];
    const ga = g[i + 3];

    // The ink layer: background white becomes fully transparent.
    const isBackground = gr >= whiteThreshold && gg >= whiteThreshold && gb >= whiteThreshold;
    const inkA = isBackground ? 0 : ga;

    // The applied-mask layer: the flat, punched through where we're filling.
    const m = mask[i] / 255;
    const appliedA = ga * (1 - m);
    const appliedF = appliedA / 255;

    // step1 — fill under the punched flat.
    let r = f[i] * (1 - appliedF) + gr * appliedF;
    let gch = f[i + 1] * (1 - appliedF) + gg * appliedF;
    let b = f[i + 2] * (1 - appliedF) + gb * appliedF;
    let a = Math.max(f[i + 3], appliedA);

    // step2 — multiply the ink back in, so lines and shading survive.
    if (multiply && inkA > 0) {
      const t = inkA / 255;
      r = r * (1 - t) + ((r * gr) / 255) * t;
      gch = gch * (1 - t) + ((gch * gg) / 255) * t;
      b = b * (1 - t) + ((b * gb) / 255) * t;
      a = Math.max(a, inkA);
    }

    // step3 — over the ink layer. A no-op for opaque fills (a === 255), which
    // is why the original's separate pass was invisible; it only matters when
    // the pattern itself is translucent.
    if (a < 255 && inkA > 0) {
      const t = a / 255;
      r = gr * (1 - t) + r * t;
      gch = gg * (1 - t) + gch * t;
      b = gb * (1 - t) + b * t;
      a = Math.max(inkA, a);
    }

    // Keep-mask: drop the ground, but never a pixel carrying ink — that's the
    // garment's own outline.
    if (removeBackground) a = (a / 255) * (inkA > 0 ? 255 : mask[i]);

    o[i] = Math.round(r);
    o[i + 1] = Math.round(gch);
    o[i + 2] = Math.round(b);
    o[i + 3] = Math.round(a);
  }
  return out;
}

/** ImageData → PNG data URL. */
export function toPngDataUrl(data: ImageData): string {
  const ctx = ctxOf(data.width, data.height);
  ctx.putImageData(data, 0, 0);
  return ctx.canvas.toDataURL('image/png');
}
