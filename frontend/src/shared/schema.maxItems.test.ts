// `maxItems` is the one reference limit Fal publishes as data rather than
// prose, so it is the one the panel should prefer over its own table.
//
// Sampled from the live OpenAPI on 2026-09-12: H3 and H3 Max declare 9 on
// `reference_image_urls`, Wan 3.0 declares 10, Grok 7, Seedance 2.0 9 — while
// Seedance 2.5, Veo 3.1, Kling O3 and Happy Horse declare nothing at all and
// state their limits only in prose. Both halves of that need to work: read it
// where it exists, stay silent where it doesn't, so the caller can fall back.

import { describe, it, expect } from 'vitest';
import { parseFalInputSchema, pickReferenceField, pickVideoReferenceField } from './schema';

/** The shape the parser expects: a components schema whose name ends "Input". */
function doc(properties: Record<string, unknown>, required: string[] = []) {
  return {
    components: { schemas: { ModelInput: { type: 'object', properties, required } } },
  } as Record<string, unknown>;
}

const field = (props: Record<string, unknown>, name: string) =>
  parseFalInputSchema(doc(props)).find((f) => f.name === name);

describe('maxItems on a media array', () => {
  it('reads it off a plain array property', () => {
    // minimax/h3-max/reference-to-video, verbatim.
    const f = field(
      {
        reference_image_urls: {
          type: 'array',
          maxItems: 9,
          items: { type: 'string' },
          description: 'URLs of subject/style reference images.',
        },
      },
      'reference_image_urls',
    );
    expect(f).toMatchObject({ kind: 'image', imageMultiple: true, maxItems: 9 });
  });

  it('reads it through the nullable anyOf wrapper Fal uses for optional fields', () => {
    // No sampled reference-to-video model wraps its array this way today, but
    // Fal does wrap other optional fields (`seed: integer | null`), and both
    // sibling helpers — primitiveType and collectEnum — already look through
    // anyOf for exactly that reason. This keeps the three consistent.
    const f = field(
      {
        image_urls: {
          anyOf: [{ type: 'array', maxItems: 4, items: { type: 'string' } }, { type: 'null' }],
          description: 'Reference images.',
        },
      },
      'image_urls',
    );
    expect(f).toMatchObject({ kind: 'image', maxItems: 4 });
  });

  it('leaves maxItems undefined when the model publishes none', () => {
    // fal-ai/veo3.1/reference-to-video — so the caller must fall back.
    const f = field(
      { image_urls: { type: 'array', items: { type: 'string' }, description: 'Reference images.' } },
      'image_urls',
    );
    expect(f?.kind).toBe('image');
    expect(f?.maxItems).toBeUndefined();
  });

  it('carries it on video arrays too', () => {
    const f = field(
      { reference_video_urls: { type: 'array', maxItems: 3, items: { type: 'string' } } },
      'reference_video_urls',
    );
    expect(f).toMatchObject({ kind: 'video', videoMultiple: true, maxItems: 3 });
  });
});

describe('the pickers surface it', () => {
  const fields = parseFalInputSchema(
    doc({
      prompt: { type: 'string', description: 'The prompt.' },
      reference_image_urls: { type: 'array', maxItems: 9, items: { type: 'string' } },
      reference_video_urls: { type: 'array', maxItems: 3, items: { type: 'string' } },
    }),
  );

  it('hands the image cap to the caller', () => {
    expect(pickReferenceField(fields)).toMatchObject({
      name: 'reference_image_urls',
      multiple: true,
      maxItems: 9,
    });
  });

  it('hands the video cap to the caller', () => {
    expect(pickVideoReferenceField(fields)).toMatchObject({
      name: 'reference_video_urls',
      maxItems: 3,
    });
  });

  it('reports a single-value field as not multiple, so the caller can cap it at one', () => {
    const single = parseFalInputSchema(
      doc({ image_url: { type: 'string', format: 'uri', description: 'One reference image.' } }),
    );
    expect(pickReferenceField(single)).toMatchObject({ name: 'image_url', multiple: false });
    expect(pickReferenceField(single)?.maxItems).toBeUndefined();
  });
});
