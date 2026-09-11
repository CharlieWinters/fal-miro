// Fit a source image inside an endpoint's pixel limit before sending it.
//
// Bria's ad-delayer refuses anything over 800 px per dimension ("use
// full-resolution as an enterprise user"), and a board image is usually well
// over that, so the feature failed on ordinary input. Nothing here is specific
// to that endpoint beyond the default: it is the general "shrink to fit, never
// upscale" step, kept in the hull so any future capped model can reuse it.
//
// The pixels come from the board, not the network: `getImagePixelRef` hands
// back a `data:` URI from the Miro SDK, which is same-origin by definition, so
// the canvas is never tainted and no proxy or upload endpoint is involved. Fal
// already accepts a data URI as an image input (it is how Miro uploads reach it
// today — see getImageUrl in boardHelpers).

/** Bria's ad-delayer caps a source image at this many pixels per dimension. */
export const MAX_AD_SOURCE_PX = 800;

export type Size = { width: number; height: number };

/** Is either dimension over the cap? */
export function exceeds(size: Size, maxPx: number = MAX_AD_SOURCE_PX): boolean {
  return size.width > maxPx || size.height > maxPx;
}

/**
 * The largest size with the same aspect ratio that fits inside `maxPx` square.
 * Never upscales, and never rounds a dimension down to zero.
 */
export function fitWithin(size: Size, maxPx: number = MAX_AD_SOURCE_PX): Size & { scale: number } {
  const width = Number(size.width);
  const height = Number(size.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { width: 0, height: 0, scale: 1 };
  }
  const scale = Math.min(1, maxPx / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    scale,
  };
}

/**
 * Seams so the decision logic is testable without a DOM. Production always
 * decodes to a real <img>; a test passes a stub cast to this type, since all
 * the logic here reads is `width`/`height`.
 */
export type DownscaleDeps = {
  load?: (url: string) => Promise<HTMLImageElement>;
  render?: (image: HTMLImageElement, size: Size) => string;
};

export type Downscaled = {
  /** The URL to send: the original when it already fits, else a data URI. */
  url: string;
  width: number;
  height: number;
  /** True when the image was re-encoded smaller. */
  scaled: boolean;
};

/**
 * Shrink `url` to fit the cap, returning the original URL untouched when it
 * already fits — a short URL beats a multi-MB base64 body, and re-encoding an
 * image that does not need it would only lose quality.
 *
 * Throws only if the image cannot be decoded at all; callers decide whether to
 * submit the original anyway.
 */
export async function downscaleToLimit(
  url: string,
  maxPx: number = MAX_AD_SOURCE_PX,
  deps: DownscaleDeps = {},
): Promise<Downscaled> {
  const load = deps.load ?? loadImage;
  const render = deps.render ?? renderToDataUrl;

  const image = await load(url);
  const source = { width: image.width, height: image.height };
  if (!exceeds(source, maxPx)) {
    return { url, width: source.width, height: source.height, scaled: false };
  }
  const target = fitWithin(source, maxPx);
  return { url: render(image, target), width: target.width, height: target.height, scaled: true };
}

/**
 * A `data:` URI loads with no CORS question at all. A remote URL needs
 * `crossOrigin` set before `src`, or the canvas it is drawn into is tainted and
 * `toDataURL` throws — Fal's CDN does send the header, so a fal.media source
 * still works.
 */
function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (!url.startsWith('data:')) img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not decode that image'));
    img.src = url;
  });
}

function renderToDataUrl(image: HTMLImageElement, size: Size): string {
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D is unavailable');
  ctx.drawImage(image, 0, 0, size.width, size.height);
  // PNG rather than JPEG: an ad is mostly type and flat colour, and the model
  // has to read the letterforms to trace or transcribe them.
  return canvas.toDataURL('image/png');
}
