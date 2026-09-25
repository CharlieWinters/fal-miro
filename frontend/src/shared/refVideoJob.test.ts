// The panel and the node's confirm modal both build fal_video_gen payloads
// through here, so these pin the shape the agent reads.
import { describe, it, expect } from 'vitest';
import { buildRefVideoInput, ratioFromValues, refVideoPayload } from './refVideoJob';
import type { Field } from './schema';

const f = (name: string, kind: Field['kind'] = 'string') => ({ name, kind, label: name }) as unknown as Field;

describe('buildRefVideoInput', () => {
  it('drops empty values and the basket-driven reference fields, parses json fields', () => {
    const out = buildRefVideoInput(
      [f('aspect_ratio'), f('reference_image_urls'), f('extra', 'json' as Field['kind'])],
      { aspect_ratio: '9:16', reference_image_urls: ['x'], seed: '', extra: '{"a":1}' },
      ['reference_image_urls'],
    );
    expect(out).toEqual({ aspect_ratio: '9:16', extra: { a: 1 } });
  });
});

describe('ratioFromValues', () => {
  it('maps a known aspect ratio and leaves adaptive to the model', () => {
    expect(ratioFromValues({ aspect_ratio: '9:16' })).toBe('9:16');
    expect(ratioFromValues({ aspect_ratio: 'adaptive' })).toBeUndefined();
  });
});

describe('refVideoPayload', () => {
  it('carries references, field names and the node anchor for MiniMax H3', () => {
    const p = refVideoPayload({
      endpointId: 'minimax/h3/reference-to-video',
      input: { prompt: 'p', aspect_ratio: '9:16' },
      values: { aspect_ratio: '9:16' },
      images: [{ id: 'i1' }, { id: 'i2' }],
      videos: [{ id: 'v1' }],
      audios: [],
      blend: false,
      imageRefField: { name: 'reference_image_urls' },
      videoRefField: { name: 'reference_video_urls' },
      audioField: { name: 'reference_audio_urls' },
      cardAnchorId: 'node-1',
      referenceFrameId: 'frame-1',
    });
    expect(p).toEqual({
      endpointId: 'minimax/h3/reference-to-video',
      input: { prompt: 'p', aspect_ratio: '9:16' },
      placeholderRatio: '9:16',
      references: {
        imageIds: ['i1', 'i2'],
        videoIds: ['v1'],
        audioIds: [],
        fields: { image: 'reference_image_urls', video: 'reference_video_urls', audio: 'reference_audio_urls' },
      },
      cardAnchorId: 'node-1',
      referenceFrameId: 'frame-1',
    });
  });

  it('sends no video or audio ids to a model without those fields (Veo blend)', () => {
    const p = refVideoPayload({
      endpointId: 'fal-ai/veo3.1/reference-to-video',
      input: {},
      values: {},
      images: [{ id: 'i1' }],
      videos: [{ id: 'v1' }],
      audios: [{ id: 'a1' }],
      blend: true,
      imageRefField: { name: 'image_urls' },
    }) as { references: Record<string, unknown> };
    expect(p.references).toEqual({ imageIds: ['i1'], blend: true, fields: { image: 'image_urls' } });
  });
});
