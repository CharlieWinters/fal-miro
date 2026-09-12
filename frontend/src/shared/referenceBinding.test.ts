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
import {
  bindReferences,
  bindSeedanceReferences,
  bindVideoReferences,
  videoReferenceCaps,
  videoReferenceDialect,
  videoReferenceToken,
} from './referenceBinding';

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

// ─────────────────────────────────────────────────────────────────────────────
// Reference-to-video dialects.
//
// The live failure these defend: selecting two references and generating on
// minimax/h3-max/reference-to-video came back "Value error, At least one
// reference image, video, or audio must be provided". The panel had sent them
// as `image_urls` with `@Image1` in the prompt — Seedance's dialect — and H3
// Max reads `reference_image_urls` and cites "Image 1". Nothing was wrong with
// the references; they were filed under a name that model has never had.
//
// The endpoint ids below are real, and every dialect assignment was confirmed
// by generating a clip against that endpoint on 2026-09-12.
// ─────────────────────────────────────────────────────────────────────────────

const ACTOR = { url: 'https://x/actor.jpg', title: 'ACTOR_REF' };
const SCENE = { url: 'https://x/scene.jpg', title: 'SCENE_REF' };
const MOVE = { url: 'https://x/move.mp4', title: 'MOVE_REF' };

describe('videoReferenceDialect', () => {
  const cases: Array<[string, string]> = [
    ['bytedance/seedance-2.5/reference-to-video', 'seedance'],
    ['bytedance/seedance-2.0/reference-to-video', 'seedance'],
    ['fal-ai/kling-video/o3/pro/reference-to-video', 'seedance'],
    ['minimax/h3-max/reference-to-video', 'positional'],
    ['minimax/h3/reference-to-video', 'positional'],
    ['alibaba/wan-3.0/reference-to-video', 'positional'],
    ['alibaba/happy-horse/v1.1/reference-to-video', 'character'],
    ['xai/grok-imagine-video/v1.5/reference-to-video', 'bracket'],
    ['fal-ai/veo3.1/reference-to-video', 'none'],
    ['google/gemini-omni-flash/v1.1/reference-to-video', 'none'],
  ];
  for (const [endpointId, expected] of cases) {
    it(`classifies ${endpointId} as ${expected}`, () => {
      expect(videoReferenceDialect(endpointId)).toBe(expected);
    });
  }

  it('falls back to the neutral legend for an endpoint nobody has classified', () => {
    // The catalog syncs live, so unknown endpoints are the normal case, not an
    // error. They must still bind — just without a token scheme.
    expect(videoReferenceDialect('some-vendor/brand-new-model/reference-to-video')).toBe('legend');
  });
});

describe('bindVideoReferences — per-dialect prompt rewrites', () => {
  const base = { prompt: 'ACTOR_REF waves in SCENE_REF', images: [ACTOR, SCENE] };

  it('keeps Seedance on @ImageN', () => {
    const out = bindVideoReferences({ ...base, endpointId: 'bytedance/seedance-2.0/reference-to-video' });
    expect(out.prompt).toBe('@Image1 waves in @Image2');
  });

  it('uses spaced "Image N" for MiniMax and Wan', () => {
    const out = bindVideoReferences({ ...base, endpointId: 'minimax/h3-max/reference-to-video' });
    expect(out.prompt).toBe('Image 1 waves in Image 2');
  });

  it('uses characterN for Happy Horse', () => {
    const out = bindVideoReferences({ ...base, endpointId: 'alibaba/happy-horse/v1.1/reference-to-video' });
    expect(out.prompt).toBe('character1 waves in character2');
  });

  it('counts from zero for Grok', () => {
    const out = bindVideoReferences({ ...base, endpointId: 'xai/grok-imagine-video/v1.5/reference-to-video' });
    expect(out.prompt).toBe('<IMAGE_0> waves in <IMAGE_1>');
  });

  it('leaves the prompt untouched for list-order models', () => {
    const out = bindVideoReferences({ ...base, endpointId: 'fal-ai/veo3.1/reference-to-video' });
    expect(out.prompt).toBe('ACTOR_REF waves in SCENE_REF');
  });

  it('prepends a legend for an unclassified endpoint', () => {
    const out = bindVideoReferences({ ...base, endpointId: 'vendor/unknown/reference-to-video' });
    expect(out.prompt).toBe(
      'Reference image 1 is ACTOR_REF. Reference image 2 is SCENE_REF. ACTOR_REF waves in SCENE_REF',
    );
  });

  it('does not rewrite when the author already wrote the tokens', () => {
    const out = bindVideoReferences({
      endpointId: 'minimax/h3/reference-to-video',
      prompt: 'Image 2 is the set; Image 1 walks into it',
      images: [ACTOR, SCENE],
    });
    expect(out.prompt).toBe('Image 2 is the set; Image 1 walks into it');
  });

  it('sends basket order per modality regardless of dialect', () => {
    const out = bindVideoReferences({
      endpointId: 'minimax/h3-max/reference-to-video',
      prompt: 'MOVE_REF drives the camera over SCENE_REF',
      images: [ACTOR, SCENE],
      videos: [MOVE],
    });
    expect(out.images).toEqual([ACTOR.url, SCENE.url]);
    expect(out.videos).toEqual([MOVE.url]);
    expect(out.prompt).toBe('Video 1 drives the camera over Image 2');
  });

  it('never renames a modality the dialect cannot address', () => {
    // Happy Horse has no video references at all; a clip in the basket must
    // not turn into a character token.
    const out = bindVideoReferences({
      endpointId: 'alibaba/happy-horse/v1.1/reference-to-video',
      prompt: 'ACTOR_REF waves, MOVE_REF pans',
      images: [ACTOR],
      videos: [MOVE],
    });
    expect(out.prompt).toBe('character1 waves, MOVE_REF pans');
  });
});

describe('videoReferenceCaps', () => {
  it('gives Veo its 3 blended images and no clips', () => {
    expect(videoReferenceCaps('fal-ai/veo3.1/reference-to-video')).toEqual({
      images: 3,
      videos: 0,
      audios: 0,
    });
  });

  it('gives Seedance 2.5 its much larger budget', () => {
    expect(videoReferenceCaps('bytedance/seedance-2.5/reference-to-video').images).toBe(30);
  });

  it('keeps Seedance 2.0 at 9 + 3', () => {
    const caps = videoReferenceCaps('bytedance/seedance-2.0/reference-to-video');
    expect([caps.images, caps.videos]).toEqual([9, 3]);
  });

  it('defaults an unknown endpoint to a usable budget rather than a timid one', () => {
    // Truncating a basket the model would have accepted is an invisible
    // failure; letting the model reject it is a visible one.
    expect(videoReferenceCaps('vendor/unknown/reference-to-video')).toEqual({
      images: 9,
      videos: 3,
      audios: 3,
    });
  });
});

describe('videoReferenceToken', () => {
  it('spells each dialect the way its model does', () => {
    expect(videoReferenceToken('seedance', 'image', 0)).toBe('@Image1');
    expect(videoReferenceToken('positional', 'video', 1)).toBe('Video 2');
    expect(videoReferenceToken('character', 'image', 2)).toBe('character3');
    expect(videoReferenceToken('bracket', 'image', 0)).toBe('<IMAGE_0>');
  });

  it('returns null where there is no token to show', () => {
    // The panel renders no chip for these rather than a misleading one.
    expect(videoReferenceToken('none', 'image', 0)).toBeNull();
    expect(videoReferenceToken('legend', 'image', 0)).toBeNull();
    expect(videoReferenceToken('character', 'video', 0)).toBeNull();
    expect(videoReferenceToken('bracket', 'audio', 0)).toBeNull();
  });
});
