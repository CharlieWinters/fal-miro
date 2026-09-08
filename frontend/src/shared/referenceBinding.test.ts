// The contract these tests defend: **the basket order is the order sent**.
//
// An earlier version sorted references by where their board title first
// appeared in the prompt. That was reasonable before baskets existed, when the
// user had no way to say "this one first". Once the basket rows became
// drag-reorderable, re-deriving the order from prose silently overrode the one
// thing the user was directly controlling — and the failure was invisible,
// because the panel went on showing @Image1 next to the row it no longer sent
// first.
//
// The first two tests below are the live reproduction, kept verbatim. They came
// out of one real generation against fal-ai/nano-banana/edit: a basket of
// [hero-shot, texture] with a prompt mentioning "granite texture" sent the
// texture swatch as image_urls[0] while the prompt's @Image1 meant the
// lighthouse, so the model received two contradictory instructions.

import { describe, it, expect } from 'vitest';
import { bindReferences, bindSeedanceReferences } from './referenceBinding';

const HERO = { url: 'https://x/hero.png', title: 'hero-shot' };
const TEX = { url: 'https://x/tex.png', title: 'texture' };

const editOpts = { multiple: true, endpointId: 'fal-ai/nano-banana/edit' };

describe('regression — a title used as an ordinary word must not reorder', () => {
  it('keeps basket order when the prompt happens to say "texture"', () => {
    const out = bindReferences({
      ...editOpts,
      refs: [HERO, TEX],
      prompt:
        'Restyle @Image1 so the stonework takes on the granite texture of @Image2. Keep the composition and the fog.',
    });
    expect(out.urls).toEqual([HERO.url, TEX.url]);
    expect(out.prompt).toContain('Reference image 1 is hero-shot');
    expect(out.prompt).toContain('Reference image 2 is texture');
  });

  it('sends the same order regardless of prompt wording', () => {
    const refs = [HERO, TEX];
    const clean = bindReferences({ ...editOpts, refs, prompt: 'Make it stormier.' });
    const dirty = bindReferences({ ...editOpts, refs, prompt: 'Add granite texture.' });
    // Same basket in, same order out. The prompt is not an ordering input.
    expect(dirty.urls).toEqual(clean.urls);
    expect(dirty.urls).toEqual([HERO.url, TEX.url]);
  });
});

describe('bindReferences', () => {
  it('numbers the legend by basket position', () => {
    const out = bindReferences({ ...editOpts, refs: [TEX, HERO], prompt: 'Blend them.' });
    expect(out.urls).toEqual([TEX.url, HERO.url]);
    expect(out.prompt).toBe('Reference image 1 is texture. Reference image 2 is hero-shot. Blend them.');
  });

  it('reflects a reorder — swapping the basket swaps what is sent', () => {
    const a = bindReferences({ ...editOpts, refs: [HERO, TEX], prompt: 'Blend them.' });
    const b = bindReferences({ ...editOpts, refs: [TEX, HERO], prompt: 'Blend them.' });
    expect(a.urls).toEqual([...b.urls].reverse());
  });

  it('skips untitled refs in the legend but still sends them', () => {
    const out = bindReferences({
      ...editOpts,
      refs: [HERO, { url: 'https://x/anon.png' }],
      prompt: 'Blend them.',
    });
    expect(out.urls).toHaveLength(2);
    expect(out.prompt).toBe('Reference image 1 is hero-shot. Blend them.');
  });

  it('adds no legend when nothing is titled', () => {
    const out = bindReferences({
      ...editOpts,
      refs: [{ url: 'https://x/a.png' }, { url: 'https://x/b.png' }],
      prompt: 'Blend them.',
    });
    expect(out.prompt).toBe('Blend them.');
  });

  it('takes the first basket row for single-input models', () => {
    const out = bindReferences({
      refs: [HERO, TEX],
      prompt: 'Make it stormier, with texture.',
      multiple: false,
      endpointId: 'fal-ai/some/single-image-model',
    });
    // Not "whichever title the prompt mentions first" — the top of the basket.
    expect(out.urls).toEqual([HERO.url]);
    expect(out.prompt).toBe('Make it stormier, with texture.');
  });

  it('returns nothing for an empty basket', () => {
    const out = bindReferences({ ...editOpts, refs: [], prompt: 'Anything.' });
    expect(out.urls).toEqual([]);
    expect(out.prompt).toBe('Anything.');
  });
});

describe('bindReferences — per-model token rewrites', () => {
  it('rewrites titles to @ImageN by basket position for Kling', () => {
    const out = bindReferences({
      refs: [HERO, TEX],
      prompt: 'Put texture on hero-shot.',
      multiple: true,
      endpointId: 'fal-ai/kling-video/v2/pro/image-to-video',
    });
    expect(out.urls).toEqual([HERO.url, TEX.url]);
    // hero-shot is basket row 1, texture row 2 — regardless of prompt order.
    expect(out.prompt).toBe('Put @Image2 on @Image1.');
  });

  it('rewrites to OmniGen tokens by basket position', () => {
    const out = bindReferences({
      refs: [HERO, TEX],
      prompt: 'Put texture on hero-shot.',
      multiple: true,
      endpointId: 'fal-ai/omnigen-v1',
    });
    expect(out.prompt).toBe('Put <|image_2|> on <|image_1|>.');
  });
});

describe('bindSeedanceReferences', () => {
  const BOAT = { url: 'https://x/boat.png', title: 'boat' };
  const GULL = { url: 'https://x/gull.png', title: 'gull' };

  it('sends basket order for every modality', () => {
    const out = bindSeedanceReferences({
      prompt: 'A slow push in.',
      images: [BOAT, GULL],
      videos: [{ url: 'https://x/v.mp4', title: 'plate' }],
      audios: [{ url: 'https://x/a.mp3', title: 'swell' }],
    });
    expect(out.image_urls).toEqual([BOAT.url, GULL.url]);
    expect(out.video_urls).toEqual(['https://x/v.mp4']);
    expect(out.audio_urls).toEqual(['https://x/a.mp3']);
  });

  it('rewrites a board title to the token for its basket position', () => {
    const out = bindSeedanceReferences({
      prompt: 'The gull circles the boat.',
      images: [BOAT, GULL],
    });
    // boat is row 1 and gull row 2, even though gull is mentioned first.
    expect(out.prompt).toBe('The @Image2 circles the @Image1.');
    expect(out.image_urls).toEqual([BOAT.url, GULL.url]);
  });

  it('leaves an already-explicit prompt alone', () => {
    const out = bindSeedanceReferences({
      prompt: '@Image1 drifts while @Image2 climbs.',
      images: [BOAT, GULL],
    });
    expect(out.prompt).toBe('@Image1 drifts while @Image2 climbs.');
    expect(out.image_urls).toEqual([BOAT.url, GULL.url]);
  });

  it('does not reorder when a title appears incidentally', () => {
    const a = bindSeedanceReferences({ prompt: 'A slow push in.', images: [BOAT, GULL] });
    const b = bindSeedanceReferences({ prompt: 'The gull is central.', images: [BOAT, GULL] });
    expect(b.image_urls).toEqual(a.image_urls);
  });

  it('tolerates missing modalities', () => {
    const out = bindSeedanceReferences({ prompt: 'Anything.', images: [] });
    expect(out).toEqual({ image_urls: [], video_urls: [], audio_urls: [], prompt: 'Anything.' });
  });
});

describe('bindSeedanceReferences — video and audio tokens', () => {
  const BOAT = { url: 'https://x/boat.png', title: 'boat' };
  const PLATE = { url: 'https://x/v.mp4', title: 'plate' };
  const SWELL = { url: 'https://x/a.mp3', title: 'swell' };

  it('rewrites a video title to @VideoN and an audio title to @AudioN', () => {
    const out = bindSeedanceReferences({
      prompt: 'The plate loops while the swell rises.',
      images: [],
      videos: [PLATE],
      audios: [SWELL],
    });
    expect(out.prompt).toBe('The @Video1 loops while the @Audio1 rises.');
    expect(out.prompt).toContain('@Video1');
    expect(out.prompt).toContain('@Audio1');
    // Each modality gets its own token — a video is never an @Image.
    expect(out.prompt).not.toMatch(/@Image/);
    expect(out.prompt).not.toMatch(/@Audio\d+ loops/);
    expect(out.prompt).not.toMatch(/@Video\d+ rises/);
  });

  it('numbers each modality independently by its own basket position', () => {
    const out = bindSeedanceReferences({
      prompt: 'boat, plate, swell.',
      images: [BOAT],
      videos: [PLATE],
      audios: [SWELL],
    });
    // All three are row 1 of their own basket, so all are token 1.
    expect(out.prompt).toBe('@Image1, @Video1, @Audio1.');
  });

  it('rewrites every mention of an image title, not just the first', () => {
    const out = bindSeedanceReferences({
      prompt: 'The boat drifts. Then the boat turns. Finally the boat sinks.',
      images: [BOAT],
    });
    expect(out.prompt).toBe('The @Image1 drifts. Then the @Image1 turns. Finally the @Image1 sinks.');
    expect(out.prompt).not.toMatch(/\bboat\b/i);
  });

  it('rewrites every mention of a video title', () => {
    const out = bindSeedanceReferences({
      prompt: 'Match the plate, then cut back to the plate.',
      images: [],
      videos: [PLATE],
    });
    expect(out.prompt).toBe('Match the @Video1, then cut back to the @Video1.');
    expect(out.prompt).not.toMatch(/\bplate\b/i);
  });

  it('rewrites every mention of an audio title', () => {
    const out = bindSeedanceReferences({
      prompt: 'Start the swell quietly; the swell peaks at the end.',
      images: [],
      audios: [SWELL],
    });
    expect(out.prompt).toBe('Start the @Audio1 quietly; the @Audio1 peaks at the end.');
    expect(out.prompt).not.toMatch(/\bswell\b/i);
  });

  it('matches titles case-insensitively at every occurrence', () => {
    const out = bindSeedanceReferences({ prompt: 'Boat. boat. BOAT.', images: [BOAT] });
    expect(out.prompt).toBe('@Image1. @Image1. @Image1.');
  });
});

describe('bindReferences — Kling rewrites every repeated mention', () => {
  it('replaces all occurrences of each title, in basket order', () => {
    const out = bindReferences({
      refs: [HERO, TEX],
      prompt: 'Take hero-shot, add texture, keep hero-shot sharp, more texture.',
      multiple: true,
      endpointId: 'fal-ai/kling-video/v2/pro/image-to-video',
    });
    expect(out.prompt).toBe('Take @Image1, add @Image2, keep @Image1 sharp, more @Image2.');
    expect(out.prompt).not.toMatch(/hero-shot|texture/i);
    expect(out.urls).toEqual([HERO.url, TEX.url]);
  });
});
