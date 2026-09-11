// Routing rules for the synced catalog.
//
// These tests exist because this file's ENDPOINT_OVERRIDES have been wrong
// twice in ways nothing caught: video-to-sound models routed to the video form
// and asked for a URL instead of offering the board's video embeds, and the
// two-frame rule matched five of the nineteen endpoints that needed it. Both
// were found by hand, on a board, long after the fact.
//
// A wrong rule here never throws. It silently sends a model to the wrong
// screen, or drops it out of the browser entirely — so the assertions below
// are mostly about *which* endpoints a pattern does and does not claim.

import { describe, it, expect } from 'vitest';
import {
  mergeSyncedCatalog,
  categoryOf,
  providerOf,
  DEFAULT_MEDIA_CATEGORIES,
  type SyncedMeta,
  type FalModel,
} from './falCatalog';

/** A synced-metadata row with only the fields a test cares about. */
function meta(endpointId: string, category: string, extra: Partial<SyncedMeta> = {}): SyncedMeta {
  return {
    endpointId,
    displayName: null,
    category,
    tags: [],
    status: 'active',
    thumbnailUrl: null,
    ...extra,
  };
}

/** Merge one row and return the primary (non-EXTRA_TASKS) model for it. */
function route(endpointId: string, category: string): FalModel {
  const out = mergeSyncedCatalog([meta(endpointId, category)]);
  expect(out.length).toBeGreaterThan(0);
  return out[0];
}

describe('mergeSyncedCatalog — basic mapping', () => {
  it("takes the capability from fal's own category", () => {
    expect(route('fal-ai/flux/dev', 'text-to-image').capability).toBe('image');
    expect(route('fal-ai/some/model', 'image-to-video').capability).toBe('video');
    expect(route('fal-ai/some/mesh', 'image-to-3d').capability).toBe('model3d');
    expect(route('fal-ai/some/tts', 'text-to-speech').capability).toBe('audio');
  });

  it('marks text-to-* as generate, and image-to-* as not', () => {
    expect(route('fal-ai/flux/dev', 'text-to-image').generate).toBe(true);
    expect(route('fal-ai/flux/edit', 'image-to-image').generate).toBeUndefined();
  });

  it('routes an unknown category to the generic screen rather than dropping it', () => {
    const m = route('fal-ai/something/new', 'brand-new-category');
    expect(m.screen).toBe('generic');
    expect(m.category).toBe('Brand New Category');
  });

  it('skips retired endpoints and de-duplicates by id', () => {
    const out = mergeSyncedCatalog([
      meta('fal-ai/a', 'text-to-image'),
      meta('fal-ai/a', 'text-to-image'),
      meta('fal-ai/b', 'text-to-image', { status: 'deprecated' }),
    ]);
    expect(out.map((m) => m.endpointId)).toEqual(['fal-ai/a']);
  });
});

describe('video-to-sound routing', () => {
  // The bug: fal files ThinkSound/MMAudio/Foley under `video-to-video`, because
  // they return the same video with audio muxed in. Without the override they
  // land on the video form, which asks for a URL — so sound was simply not
  // selectable from a board.
  const soundModels = [
    'fal-ai/thinksound',
    'fal-ai/mmaudio-v2',
    'fal-ai/hunyuan-foley',
    'fal-ai/mmaudio-v2/text-to-audio',
  ];

  it.each(soundModels)('routes %s to the sound capability', (id) => {
    expect(route(id, 'video-to-video').capability).toBe('sound');
  });

  it('leaves other video-to-video models alone', () => {
    expect(route('fal-ai/luma-dream-machine/modify', 'video-to-video').capability).toBe('video');
    expect(route('fal-ai/some/upscaler', 'video-to-video').capability).toBe('video');
  });

  it("needs no override when fal already says video-to-audio", () => {
    expect(route('fal-ai/some/other-sound-model', 'video-to-audio').capability).toBe('sound');
  });
});

describe('two-frame (first + last) routing', () => {
  // The bug: every vendor spells this differently, and the original pattern
  // caught five of them. Each entry below is a distinct vendor spelling.
  const twoFrame = [
    'fal-ai/veo2/first-last-frame-to-video',
    'fal-ai/vidu/q1/start-end-to-video',
    'fal-ai/wan-flf2v',
    'fal-ai/framepack/flf2v',
    'fal-ai/flux-3/keyframes-to-video',
    'fal-ai/pixverse/v4.5/transition',
    'fal-ai/amt-frame-interpolation',
  ];

  it.each(twoFrame)('flags %s as twoFrame', (id) => {
    const m = route(id, 'image-to-video');
    expect(m.twoFrame).toBe(true);
    expect(m.task).toBe('First + Last');
  });

  it('does not flag ordinary image-to-video models', () => {
    expect(route('fal-ai/kling-video/v2/standard/image-to-video', 'image-to-video').twoFrame).toBeUndefined();
  });

  it('does not claim the LoRA trainers and interpolators that share those words', () => {
    // This is what `whenCategory: 'image-to-video'` buys. A name-only pattern
    // matches all three of these.
    expect(route('fal-ai/some-frame-interpolation-trainer', 'training').twoFrame).toBeUndefined();
    expect(route('fal-ai/vid/frame-interpolation', 'video-to-video').twoFrame).toBeUndefined();
    expect(route('fal-ai/flux-lora/keyframes-to-video', 'text-to-image').twoFrame).toBeUndefined();
  });
});

describe('segmentation routing', () => {
  it('routes SAM image-to-image endpoints to the cutout screen', () => {
    expect(route('fal-ai/sam-2/image', 'image-to-image').capability).toBe('segment');
    expect(route('fal-ai/sam-3', 'image-to-image').capability).toBe('segment');
    expect(route('fal-ai/evf-sam', 'image-to-image').capability).toBe('segment');
  });

  it('leaves the -rle twins on the generic form — they return encoding, not an image', () => {
    expect(route('fal-ai/sam-3/image-rle', 'image-to-image').capability).not.toBe('segment');
  });

  it('does not claim the SAM siblings in other categories', () => {
    // `sam-3` also matches sam-3/video and sam-3/3d-body.
    expect(route('fal-ai/sam-3/video', 'video-to-video').capability).not.toBe('segment');
    expect(route('fal-ai/sam-3/3d-body', 'image-to-3d').capability).not.toBe('segment');
  });
});

describe('panorama and rigging routing', () => {
  it('routes equirectangular output to the photosphere screen', () => {
    expect(route('fal-ai/hunyuan_world/v1', 'image-to-image').capability).toBe('panorama');
    expect(route('fal-ai/some/image-to-panorama', 'image-to-image').capability).toBe('panorama');
  });

  it('leaves image-to-world alone — a 3D scene is not a panorama', () => {
    expect(route('fal-ai/hunyuan_world/image-to-world', 'image-to-3d').capability).not.toBe('panorama');
  });

  it('routes rigging to the rig screen despite fal filing it as 3d-to-3d', () => {
    const m = route('fal-ai/meshy/rigging', '3d-to-3d');
    expect(m.capability).toBe('rig');
    expect(m.task).toBe('Rig + Animate');
  });
});

describe('ffmpeg merge routing', () => {
  it('claims only the two merges that have a screen', () => {
    expect(route('fal-ai/ffmpeg-api/merge-videos', 'video-to-video').capability).toBe('merge');
    expect(route('fal-ai/ffmpeg-api/merge-audio-video', 'video-to-video').capability).toBe('merge');
  });

  it('leaves merge-audios alone — there is no screen for it', () => {
    expect(route('fal-ai/ffmpeg-api/merge-audios', 'audio-to-audio').capability).not.toBe('merge');
  });
});

describe('EXTRA_TASKS', () => {
  it('gives Seedance image-to-video a second start+end variant', () => {
    const out = mergeSyncedCatalog([meta('fal-ai/bytedance/seedance/v1/pro/image-to-video', 'image-to-video')]);
    expect(out).toHaveLength(2);
    const [primary, extra] = out;
    expect(primary.twoFrame).toBeUndefined();
    expect(extra.twoFrame).toBe(true);
    expect(extra.task).toBe('Start + End');
    // Same endpoint, two browsable entries.
    expect(extra.endpointId).toBe(primary.endpointId);
  });

  it('adds nothing when the sync did not return that endpoint', () => {
    expect(mergeSyncedCatalog([meta('fal-ai/other/image-to-video', 'image-to-video')])).toHaveLength(1);
  });
});

describe('overrides stay inside the default curation filter', () => {
  // The regression this guards: an override that sets a prettier `category`
  // (e.g. "Extract object") puts the model in a category DEFAULT_MEDIA_CATEGORIES
  // does not list, so the default filter hides it and the model vanishes from
  // the browser with no error anywhere.
  const overridden: Array<[string, string]> = [
    ['fal-ai/sam-2/image', 'image-to-image'],
    ['fal-ai/hunyuan_world/v1', 'image-to-image'],
    ['fal-ai/meshy/rigging', '3d-to-3d'],
    ['fal-ai/ffmpeg-api/merge-videos', 'video-to-video'],
    ['fal-ai/thinksound', 'video-to-video'],
    ['fal-ai/veo2/first-last-frame-to-video', 'image-to-video'],
  ];

  it.each(overridden)('%s lands in a category the default filter allows', (id, category) => {
    const m = route(id, category);
    expect(DEFAULT_MEDIA_CATEGORIES).toContain(categoryOf(m));
  });

  // Two things have to hold together: no override sets `category`, and
  // mergeSyncedCatalog clears it after applying one. Either alone is harmless
  // — breaking just one of them leaves this suite green, which is checked.
  // Breaking both hides models, and that this catches.
  it('no override writes a literal category — categoryOf must derive it', () => {
    for (const [id, category] of overridden) {
      expect(route(id, category).category).toBeUndefined();
    }
  });
});

describe('providerOf', () => {
  it('reads the vendor out of the endpoint id', () => {
    expect(providerOf('fal-ai/flux/dev')).toBeTruthy();
    expect(providerOf('')).toBeTruthy(); // never throws on junk
  });
});

describe('mergeSyncedCatalog — labels and status', () => {
  it("uses fal's displayName as the label and family when present", () => {
    const [m] = mergeSyncedCatalog([meta('fal-ai/flux/dev', 'text-to-image', { displayName: 'FLUX.1 [dev]' })]);
    expect(m.label).toBe('FLUX.1 [dev]');
    expect(m.family).toBe('FLUX.1 [dev]');
    expect(m.label).not.toBe('fal-ai/flux/dev');
  });

  it('falls back to the endpoint id when displayName is null or blank', () => {
    expect(route('fal-ai/flux/dev', 'text-to-image').label).toBe('fal-ai/flux/dev');
    const [blank] = mergeSyncedCatalog([meta('fal-ai/flux/dev', 'text-to-image', { displayName: '   ' })]);
    expect(blank.label).toBe('fal-ai/flux/dev');
  });

  it('trims a padded displayName', () => {
    const [m] = mergeSyncedCatalog([meta('fal-ai/flux/dev', 'text-to-image', { displayName: '  Flux Dev  ' })]);
    expect(m.label).toBe('Flux Dev');
  });

  it.each(['deprecated', 'archived', 'beta', 'retired', 'disabled'])(
    'excludes a model whose status is %s — anything not active is out',
    (status) => {
      const out = mergeSyncedCatalog([
        meta('fal-ai/a', 'text-to-image'),
        meta('fal-ai/b', 'text-to-image', { status }),
      ]);
      expect(out.map((m) => m.endpointId)).toEqual(['fal-ai/a']);
    },
  );

  it('keeps a model with status active or with no status at all', () => {
    const out = mergeSyncedCatalog([
      meta('fal-ai/a', 'text-to-image', { status: 'active' }),
      meta('fal-ai/b', 'text-to-image', { status: null }),
    ]);
    expect(out.map((m) => m.endpointId)).toEqual(['fal-ai/a', 'fal-ai/b']);
  });

  it('gives each task in a multi-task family a distinct label', () => {
    // Seedance image-to-video has two browsable entries (plain + Start/End).
    // If both carried the same label, the task picker would show two
    // indistinguishable rows.
    const out = mergeSyncedCatalog([
      meta('fal-ai/bytedance/seedance/v1/pro/image-to-video', 'image-to-video', { displayName: 'Seedance 1.0 Pro' }),
    ]);
    expect(out).toHaveLength(2);
    const labels = out.map((m) => m.label);
    expect(new Set(labels).size).toBe(labels.length);
    const [primary, extra] = out;
    expect(primary.label).toBe('Seedance 1.0 Pro');
    expect(extra.label).toBe('Seedance 1.0 Pro · Start + End');
    expect(extra.label).toContain(extra.task!);
    // Both remain in the same family so they group together in the browser.
    expect(extra.family).toBe(primary.family);
  });
});

describe('mergeSyncedCatalog — text-to-motion', () => {
  it('routes Hunyuan Motion to the motion screen, not the generic text-to-3d form', () => {
    for (const id of ['fal-ai/hunyuan-motion', 'fal-ai/hunyuan-motion/fast']) {
      const m = route(id, 'text-to-3d');
      expect(m.capability, id).toBe('motion');
      expect(m.screen, id).toBeUndefined();
      expect(m.generate, id).toBe(true);
      expect(categoryOf(m), id).toBe('Text to Motion');
    }
  });

  it('leaves other text-to-3d models on the generic form', () => {
    const m = route('fal-ai/hunyuan3d-v3/text-to-3d', 'text-to-3d');
    expect(m.capability).toBe('model3d');
    expect(m.screen).toBe('generic');
  });
});

describe('mergeSyncedCatalog — ad to layers', () => {
  it('routes Bria Ad Delayer to the layers screen, not the generic image-to-json form', () => {
    const m = route('bria/ad-delayer', 'image-to-json');
    expect(m.capability).toBe('layers');
    expect(m.screen).toBeUndefined();
    expect(categoryOf(m)).toBe('Ad to Layers');
  });

  it('leaves other image-to-json models on the generic form, as data rather than images', () => {
    const m = route('bria/fibo/generate/structured_prompt', 'image-to-json');
    expect(m.capability).toBe('data');
    expect(m.screen).toBe('generic');
    expect(m.category).toBe('Image To Json');
  });
});
