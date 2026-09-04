// Deriving the fill region from the flat itself — no model, no backend.
//
// The original app got its mask from Nova Canvas `BackgroundRemoval`: a round
// trip to AWS Bedrock for every fill. For the artwork this app actually
// targets — technical flats, dark line art on a white ground — the mask is
// already implicit in the drawing: the fill region is everything the outline
// *encloses*. A flood fill inwards from the image border through background
// pixels stops at the ink, so "not reached" is exactly the garment silhouette,
// outline included. That's a few milliseconds of local work and it's exact,
// where a segmentation model is neither.
//
// The ink is left *inside* the mask on purpose: the composite punches the
// whole silhouette out and then multiplies the lines back on top (see
// fill.ts), which is what keeps seams and shading readable through a pattern.
//
// Limits, and why the panel keeps a manual path: an open silhouette leaks. A
// sketch whose outline doesn't close (loose temples on a pair of sunglasses,
// a flat cropped at the edge of the canvas) lets the fill escape into the
// interior, and the mask comes back nearly empty. When that happens the answer
// is a real mask — fal-miro's Create Mask app (SAM 3) makes one on the board,
// and this app will read it.

import { DEFAULT_WHITE_THRESHOLD } from './fill';

export type AutoMaskResult = {
  /** RGBA, white where the fill should land. Same grid as the source. */
  mask: Uint8ClampedArray;
  /** Share of the image the mask covers, 0–1 — the panel warns on extremes. */
  coverage: number;
};

/**
 * Flood fill the background inwards from every border pixel, then invert.
 *
 * Iterative with an explicit stack and a visited byte per pixel: a recursive
 * fill blows the stack on a megapixel flat, and re-testing colour instead of
 * tracking visits makes it quadratic on large flat areas.
 */
export function autoMaskFromFlat(
  image: ImageData,
  opts: { whiteThreshold?: number } = {},
): AutoMaskResult {
  const threshold = opts.whiteThreshold ?? DEFAULT_WHITE_THRESHOLD;
  const { width: w, height: h, data } = image;
  const n = w * h;

  const isBackground = (p: number): boolean => {
    const i = p * 4;
    // A transparent pixel is background too — a flat that already had its
    // ground removed would otherwise come back as one solid mask.
    if (data[i + 3] < 8) return true;
    return data[i] >= threshold && data[i + 1] >= threshold && data[i + 2] >= threshold;
  };

  const outside = new Uint8Array(n);
  const stack = new Int32Array(n);
  let top = 0;

  const push = (p: number) => {
    if (!outside[p] && isBackground(p)) {
      outside[p] = 1;
      stack[top++] = p;
    }
  };

  for (let x = 0; x < w; x++) {
    push(x);
    push((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    push(y * w);
    push(y * w + w - 1);
  }

  while (top > 0) {
    const p = stack[--top];
    const x = p % w;
    if (x > 0) push(p - 1);
    if (x < w - 1) push(p + 1);
    if (p >= w) push(p - w);
    if (p < n - w) push(p + w);
  }

  const mask = new Uint8ClampedArray(n * 4);
  let covered = 0;
  for (let p = 0; p < n; p++) {
    const v = outside[p] ? 0 : 255;
    if (v) covered++;
    const i = p * 4;
    mask[i] = v;
    mask[i + 1] = v;
    mask[i + 2] = v;
    mask[i + 3] = 255;
  }

  return { mask, coverage: covered / n };
}

/** Flip a mask's sense — fill everything it currently protects, and vice versa. */
export function invert(mask: Uint8ClampedArray | Uint8Array): Uint8ClampedArray {
  const out = new Uint8ClampedArray(mask.length);
  for (let i = 0; i < mask.length; i += 4) {
    const v = 255 - mask[i];
    out[i] = v;
    out[i + 1] = v;
    out[i + 2] = v;
    out[i + 3] = 255;
  }
  return out;
}
