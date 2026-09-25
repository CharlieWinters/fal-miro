// How a reference-to-video run is assembled from a model's schema, the form
// values and the reference baskets. Shared by ReferenceToVideoScreen (the
// panel) and the node's confirm modal, so a run started from a node on the
// board is built exactly the way the same run started from the panel is.

import type { Field } from './schema';

/**
 * Form values → the model input, minus the reference fields (the baskets
 * drive those) and with JSON-typed fields parsed. The prompt is not in here:
 * the prompt basket owns it and callers set `input.prompt` themselves.
 */
export function buildRefVideoInput(
  fields: Field[],
  values: Record<string, unknown>,
  referenceFieldNames: string[],
): Record<string, unknown> {
  const jsonFields = new Set(fields.filter((f) => f.kind === 'json').map((f) => f.name));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined || v === null || v === '') continue;
    if (referenceFieldNames.includes(k)) continue; // driven by the baskets
    if (jsonFields.has(k) && typeof v === 'string') {
      try {
        out[k] = JSON.parse(v);
      } catch {
        /* skip invalid json field */
      }
    } else {
      out[k] = v;
    }
  }
  return out;
}

const SIZE_TO_RATIO: Record<string, string> = {
  '21:9': '21:9',
  '16:9': '16:9',
  '4:3': '4:3',
  '1:1': '1:1',
  '3:4': '3:4',
  '9:16': '9:16',
};

/** The chosen aspect_ratio → placeholder ratio, or undefined for "auto". */
export function ratioFromValues(values: Record<string, unknown>): string | undefined {
  const ar = values.aspect_ratio;
  if (typeof ar === 'string' && SIZE_TO_RATIO[ar]) return ar;
  return undefined;
}

type Ref = { id: string };

/** The fal_video_gen payload. References arrive already capped to the model's limits. */
export function refVideoPayload(o: {
  endpointId: string;
  input: Record<string, unknown>;
  values: Record<string, unknown>;
  images: Ref[];
  videos: Ref[];
  audios: Ref[];
  blend: boolean;
  imageRefField?: { name: string } | null;
  videoRefField?: { name: string } | null;
  audioField?: { name: string } | null;
  cardAnchorId?: string;
  referenceFrameId?: string;
}): Record<string, unknown> {
  return {
    endpointId: o.endpointId,
    input: o.input,
    placeholderRatio: ratioFromValues(o.values),
    references: {
      imageIds: o.images.map((i) => i.id),
      ...(o.videoRefField ? { videoIds: o.videos.map((v) => v.id) } : {}),
      ...(o.audioField ? { audioIds: o.audios.map((a) => a.id) } : {}),
      ...(o.blend ? { blend: true } : {}),
      // Resolved from this model's schema, so the agent never has to guess.
      fields: {
        ...(o.imageRefField ? { image: o.imageRefField.name } : {}),
        ...(o.videoRefField ? { video: o.videoRefField.name } : {}),
        ...(o.audioField ? { audio: o.audioField.name } : {}),
      },
    },
    ...(o.cardAnchorId ? { cardAnchorId: o.cardAnchorId } : {}),
    ...(o.referenceFrameId ? { referenceFrameId: o.referenceFrameId } : {}),
  };
}
