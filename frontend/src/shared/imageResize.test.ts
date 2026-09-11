import { describe, expect, it, vi } from 'vitest';
import { MAX_AD_SOURCE_PX, downscaleToLimit, exceeds, fitWithin } from './imageResize';

describe('exceeds', () => {
  it('is true when either dimension is over the cap', () => {
    expect(exceeds({ width: 801, height: 10 })).toBe(true);
    expect(exceeds({ width: 10, height: 801 })).toBe(true);
    expect(exceeds({ width: 800, height: 800 })).toBe(false);
    expect(exceeds({ width: 1000, height: 1000 }, 1024)).toBe(false);
  });
});

describe('fitWithin', () => {
  it('shrinks the longest side to the cap and keeps the aspect ratio', () => {
    expect(fitWithin({ width: 1600, height: 2000 }, 800)).toMatchObject({ width: 640, height: 800 });
    expect(fitWithin({ width: 2000, height: 1600 }, 800)).toMatchObject({ width: 800, height: 640 });
  });

  it('never upscales an image that already fits', () => {
    const small = fitWithin({ width: 300, height: 200 }, 800);
    expect(small).toEqual({ width: 300, height: 200, scale: 1 });
  });

  it('never rounds a dimension away to zero', () => {
    // A 10000×3 strip scales by 0.08, which would round the height to 0 and
    // make the canvas unusable.
    expect(fitWithin({ width: 10000, height: 3 }, 800).height).toBe(1);
  });

  it('returns an empty size for nonsense input rather than NaN', () => {
    for (const size of [
      { width: 0, height: 100 },
      { width: -5, height: 100 },
      { width: NaN, height: 100 },
      { width: Infinity, height: 100 },
    ])
      expect(fitWithin(size, 800), JSON.stringify(size)).toEqual({ width: 0, height: 0, scale: 1 });
  });

  it('defaults to the ad-delayer cap', () => {
    expect(fitWithin({ width: 4000, height: 4000 })).toMatchObject({ width: MAX_AD_SOURCE_PX });
  });
});

describe('downscaleToLimit', () => {
  // Only width/height are read, so a stub stands in for a decoded <img>.
  const decoded = (width: number, height: number) => ({ width, height }) as unknown as HTMLImageElement;
  const deps = (width: number, height: number) => ({
    load: vi.fn(async () => decoded(width, height)),
    render: vi.fn(
      (_img: HTMLImageElement, size: { width: number; height: number }) =>
        `data:image/png;base64,${size.width}x${size.height}`,
    ),
  });

  it('leaves an image that already fits completely alone', async () => {
    const d = deps(600, 800);
    const out = await downscaleToLimit('https://v3.fal.media/a.png', 800, d);
    // The original URL, not a re-encode: a short URL beats a base64 body.
    expect(out).toEqual({ url: 'https://v3.fal.media/a.png', width: 600, height: 800, scaled: false });
    expect(d.render).not.toHaveBeenCalled();
  });

  it('re-encodes an oversized image at the fitted size', async () => {
    const d = deps(1600, 2000);
    const out = await downscaleToLimit('data:image/png;base64,AAA', 800, d);
    expect(out).toEqual({ url: 'data:image/png;base64,640x800', width: 640, height: 800, scaled: true });
    expect(d.render).toHaveBeenCalledWith({ width: 1600, height: 2000 }, { width: 640, height: 800, scale: 0.4 });
  });

  it('lets a decode failure through so the caller can decide', async () => {
    await expect(
      downscaleToLimit('data:image/png;base64,AAA', 800, {
        load: async () => {
          throw new Error('Could not decode that image');
        },
      }),
    ).rejects.toThrow(/decode/);
  });
});
