// Turn a Fal model's OpenAPI 3.0 spec (from /api/fal/schema) into a flat list
// of input fields the panel can render. This is the core of Option A — the UI
// is built from the live schema, not hardcoded per model.

export type FieldKind =
  | 'text' // multi-line string (prompt-like)
  | 'string' // single-line string
  | 'number' // float
  | 'integer'
  | 'boolean'
  | 'enum'
  | 'image' // an image URL input (can be fed from the board)
  | 'video' // a video URL input (can be fed from a board video embed)
  | 'audio' // an audio URL input (can be fed from a board audio embed)
  | 'json'; // object/array/unknown — raw JSON for power users

export type Field = {
  name: string;
  label: string;
  description?: string;
  kind: FieldKind;
  required: boolean;
  default?: unknown;
  enumValues?: Array<string | number>;
  min?: number;
  max?: number;
  /** For `image` fields: true when it takes an array (e.g. `image_urls`). */
  imageMultiple?: boolean;
  /** For `video` fields: true when it takes an array (e.g. `video_urls`). */
  videoMultiple?: boolean;
  /** For `audio` fields: true when it takes an array (e.g. `audio_urls`). */
  audioMultiple?: boolean;
};

type AnySchema = Record<string, any>;

/** Resolve a local `#/components/...` $ref against the root document. */
function resolveRef(root: AnySchema, ref: string): AnySchema | null {
  if (!ref.startsWith('#/')) return null;
  let node: any = root;
  for (const part of ref.slice(2).split('/')) {
    node = node?.[part];
    if (node == null) return null;
  }
  return node as AnySchema;
}

/** Follow a $ref one level if present. */
function deref(root: AnySchema, schema: AnySchema): AnySchema {
  if (schema && typeof schema.$ref === 'string') {
    return resolveRef(root, schema.$ref) ?? schema;
  }
  return schema;
}

/** Collect enum values from a property, including via anyOf/oneOf and $refs. */
function collectEnum(root: AnySchema, prop: AnySchema): Array<string | number> | null {
  const direct = prop.enum;
  if (Array.isArray(direct) && direct.length) return direct;
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const branches = prop[key];
    if (Array.isArray(branches)) {
      for (const b of branches) {
        const resolved = deref(root, b);
        if (Array.isArray(resolved.enum) && resolved.enum.length) return resolved.enum;
      }
    }
  }
  return null;
}

/** First primitive type found directly or in a union branch. */
function primitiveType(root: AnySchema, prop: AnySchema): string | undefined {
  if (typeof prop.type === 'string') return prop.type;
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const branches = prop[key];
    if (Array.isArray(branches)) {
      for (const b of branches) {
        const r = deref(root, b);
        if (typeof r.type === 'string' && r.type !== 'null') return r.type;
      }
    }
  }
  return undefined;
}

function isImageField(name: string, prop: AnySchema): boolean {
  // Matches image_url(s), reference_image_url, mask_image_url, and frame urls
  // (first_frame_url / last_frame_url for first-last-frame video models).
  if (/(^|_)(image|frame)(_urls?)?$/i.test(name)) return true;
  const fmt = prop.format;
  return fmt === 'uri' && /(image|frame)/i.test(name);
}

function isVideoField(name: string, prop: AnySchema): boolean {
  // Matches video_url(s), input_video_url, reference_video_url, etc.
  if (/(^|_)video(_urls?)?$/i.test(name)) return true;
  const fmt = prop.format;
  return fmt === 'uri' && /video/i.test(name);
}

function isAudioField(name: string, prop: AnySchema): boolean {
  // Matches audio_url(s), input_audio_url, reference_audio_url, etc. — the
  // same naming convention Fal uses for image/video reference fields (e.g.
  // Seedance 2.5's `audio_urls`).
  if (/(^|_)audio(_urls?)?$/i.test(name)) return true;
  const fmt = prop.format;
  return fmt === 'uri' && /audio/i.test(name);
}

function titleFrom(name: string, prop: AnySchema): string {
  if (typeof prop.title === 'string' && prop.title.trim()) return prop.title;
  return name
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function classify(root: AnySchema, name: string, rawProp: AnySchema, required: boolean): Field {
  const prop = deref(root, rawProp);
  const base: Field = {
    name,
    label: titleFrom(name, prop),
    description: typeof prop.description === 'string' ? prop.description : undefined,
    kind: 'string',
    required,
    default: prop.default,
    min: typeof prop.minimum === 'number' ? prop.minimum : undefined,
    max: typeof prop.maximum === 'number' ? prop.maximum : undefined,
  };

  const enumValues = collectEnum(root, prop);
  if (enumValues) return { ...base, kind: 'enum', enumValues };

  if (isImageField(name, prop)) {
    const multiple = primitiveType(root, prop) === 'array' || /urls$/i.test(name);
    return { ...base, kind: 'image', imageMultiple: multiple };
  }

  if (isVideoField(name, prop)) {
    const multiple = primitiveType(root, prop) === 'array' || /urls$/i.test(name);
    return { ...base, kind: 'video', videoMultiple: multiple };
  }

  if (isAudioField(name, prop)) {
    const multiple = primitiveType(root, prop) === 'array' || /urls$/i.test(name);
    return { ...base, kind: 'audio', audioMultiple: multiple };
  }

  const type = primitiveType(root, prop);
  switch (type) {
    case 'boolean':
      return { ...base, kind: 'boolean' };
    case 'integer':
      return { ...base, kind: 'integer' };
    case 'number':
      return { ...base, kind: 'number' };
    case 'string': {
      const longHint =
        /prompt|text|description/i.test(name) ||
        (typeof prop.description === 'string' && prop.description.length > 120);
      return { ...base, kind: longHint ? 'text' : 'string' };
    }
    case 'object':
    case 'array':
      return { ...base, kind: 'json' };
    default:
      return { ...base, kind: 'string' };
  }
}

/** Locate the model's input schema object within the OpenAPI document. */
function findInputSchema(openapi: AnySchema): AnySchema | null {
  // Prefer the requestBody schema of the first POST operation.
  const paths = openapi.paths ?? {};
  for (const path of Object.keys(paths)) {
    const post = paths[path]?.post;
    const schema = post?.requestBody?.content?.['application/json']?.schema;
    if (schema) {
      const resolved = deref(openapi, schema);
      if (resolved?.properties) return resolved;
    }
  }
  // Fallback: a components schema whose name ends in "Input".
  const schemas = openapi.components?.schemas ?? {};
  const inputKey =
    Object.keys(schemas).find((k) => /input$/i.test(k) && schemas[k]?.properties) ??
    Object.keys(schemas).find((k) => schemas[k]?.properties);
  return inputKey ? schemas[inputKey] : null;
}

/**
 * Parse the OpenAPI doc into ordered input fields. Returns [] if no input
 * schema can be found (caller should fall back to a prompt-only form).
 */
export function parseFalInputSchema(openapi: Record<string, unknown>): Field[] {
  const root = openapi as AnySchema;
  const input = findInputSchema(root);
  if (!input?.properties) return [];

  const required: string[] = Array.isArray(input.required) ? input.required : [];
  const props = input.properties as Record<string, AnySchema>;

  return Object.keys(props).map((name) => classify(root, name, props[name], required.includes(name)));
}

/**
 * Split fields into the always-shown "common" tier (in the order given by
 * `commonOrder`) and the rest (Advanced). Required fields not in the common
 * list are promoted to always-shown so a generation can't be under-specified.
 */
export function splitFields(
  fields: Field[],
  commonOrder: string[],
): { common: Field[]; advanced: Field[] } {
  const byName = new Map(fields.map((f) => [f.name, f]));
  const common: Field[] = [];
  const used = new Set<string>();

  for (const name of commonOrder) {
    const f = byName.get(name);
    if (f) {
      common.push(f);
      used.add(name);
    }
  }
  for (const f of fields) {
    if (!used.has(f.name) && f.required) {
      common.push(f);
      used.add(f.name);
    }
  }
  const advanced = fields.filter((f) => !used.has(f.name));
  return { common, advanced };
}

/**
 * Pick the field that board-connected reference images should flow into.
 * Prefers `image_urls` / `image_url` / `reference_image_url`, then any other
 * top-level image field, and never a mask. Returns null if the model takes no
 * (top-level) image input — in which case references are simply not sent.
 */
export function pickReferenceField(
  fields: Field[],
): { name: string; multiple: boolean; required: boolean } | null {
  const candidates = fields.filter((f) => f.kind === 'image' && !/mask/i.test(f.name));
  if (candidates.length === 0) return null;
  // Prefer the canonical primary-image field by name, then any *required* image
  // field, and only then the first one. This matters for models with several
  // image inputs (e.g. Hunyuan3D v3's optional multi-view back/left/right URLs
  // alongside the required `input_image_url`) — falling back to candidates[0]
  // would pick an optional field and lose the image-primary board flow.
  const preferred = ['image_urls', 'image_url', 'input_image_url', 'reference_image_url'];
  const chosen =
    preferred.map((n) => candidates.find((f) => f.name === n)).find(Boolean) ??
    candidates.find((f) => f.required) ??
    candidates[0];
  return { name: chosen.name, multiple: Boolean(chosen.imageMultiple), required: chosen.required };
}

/**
 * Pick the field that a board-selected video should flow into (video-to-video /
 * video-edit models, e.g. Google Omni Video Edit's `video_url`). Same
 * preference order as `pickReferenceField`, mirrored for video fields.
 */
export function pickVideoReferenceField(
  fields: Field[],
): { name: string; multiple: boolean; required: boolean } | null {
  const candidates = fields.filter((f) => f.kind === 'video');
  if (candidates.length === 0) return null;
  const preferred = ['video_urls', 'video_url', 'input_video_url'];
  const chosen =
    preferred.map((n) => candidates.find((f) => f.name === n)).find(Boolean) ??
    candidates.find((f) => f.required) ??
    candidates[0];
  return { name: chosen.name, multiple: Boolean(chosen.videoMultiple), required: chosen.required };
}

// The model's primary free-text field — the one a selected sticky's text (or
// a reopened recipe's connected sticky) should drive. `prompt` is by far the
// most common name; several real models — mostly TTS (Orpheus, ElevenLabs,
// ChatterboxHD) — use `text` instead. Checked in this order since a model
// could in principle have both; `prompt` wins if so.
const PROMPT_FIELD_NAMES = ['prompt', 'text'];

export function pickPromptField(fields: Field[]): Field | undefined {
  for (const name of PROMPT_FIELD_NAMES) {
    const field = fields.find((f) => f.name === name);
    if (field) return field;
  }
  return undefined;
}

/**
 * Pick the field that a board-selected audio clip should flow into (e.g.
 * Seedance 2.5's `audio_urls`). Same preference order as
 * `pickReferenceField`/`pickVideoReferenceField` — this is the schema-driven
 * check for "does this model take audio references at all", so the board
 * only offers/collects audio for models that actually declare such a field.
 */
export function pickAudioReferenceField(
  fields: Field[],
): { name: string; multiple: boolean; required: boolean } | null {
  const candidates = fields.filter((f) => f.kind === 'audio');
  if (candidates.length === 0) return null;
  const preferred = ['audio_urls', 'audio_url', 'input_audio_url'];
  const chosen =
    preferred.map((n) => candidates.find((f) => f.name === n)).find(Boolean) ??
    candidates.find((f) => f.required) ??
    candidates[0];
  return { name: chosen.name, multiple: Boolean(chosen.audioMultiple), required: chosen.required };
}

// Fal's named-bucket size convention (e.g. FLUX's `image_size`), as an
// alternative to a plain "W:H" `aspect_ratio` field. Maps a bucket name to the
// ratio it represents — the same table ImageGenScreen/ReferenceToVideoScreen
// use client-side to read a *chosen* size back into a ratio.
const IMAGE_SIZE_RATIOS: Record<string, string> = {
  square: '1:1',
  square_hd: '1:1',
  landscape_4_3: '4:3',
  landscape_16_9: '16:9',
  portrait_4_3: '3:4',
  portrait_16_9: '9:16',
};

export type AspectRatioField = {
  name: string;
  /** The field's own value for a given "W:H" ratio, or null if this field
   *  can't represent that ratio (e.g. an enum that has no matching option). */
  valueForRatio: (ratio: string) => string | null;
};

/**
 * Find the model's aspect-ratio-shaped input field, schema-driven — either a
 * literal `aspect_ratio` field (values are "W:H" strings, e.g. Seedance) or an
 * `image_size` field using Fal's named-bucket convention (e.g. FLUX's
 * `landscape_16_9`). Returns null if the model has neither, so a caller can
 * skip overriding anything instead of guessing at a value shape that doesn't
 * apply. Used to push a frame-derived ratio into the actual generation
 * request — not just the placeholder's on-board size.
 */
export function pickAspectRatioField(fields: Field[]): AspectRatioField | null {
  const ratioField = fields.find((f) => f.name === 'aspect_ratio');
  if (ratioField) {
    const enumValues = ratioField.kind === 'enum' ? ratioField.enumValues ?? [] : null;
    return {
      name: 'aspect_ratio',
      valueForRatio: (ratio) => {
        if (!enumValues) return ratio; // free-form string field — pass it through
        return enumValues.some((v) => String(v) === ratio) ? ratio : null;
      },
    };
  }

  const sizeField = fields.find((f) => f.name === 'image_size');
  if (sizeField?.kind === 'enum' && sizeField.enumValues) {
    const enumValues = sizeField.enumValues;
    return {
      name: 'image_size',
      valueForRatio: (ratio) => {
        const bucket = Object.entries(IMAGE_SIZE_RATIOS).find(([, r]) => r === ratio)?.[0];
        return bucket && enumValues.some((v) => String(v) === bucket) ? bucket : null;
      },
    };
  }

  return null;
}

/**
 * All *single* (non-array, non-mask) image fields, ordered with the required
 * one(s) first. Models with several of these are "multi-view" — e.g. Hunyuan3D
 * v3 takes `input_image_url` (front, required) plus optional back/left/right
 * views of the same object — and get a named-slot UI rather than one selector.
 */
export function pickViewImageFields(
  fields: Field[],
): Array<{ name: string; label: string; required: boolean }> {
  return fields
    .filter((f) => f.kind === 'image' && !f.imageMultiple && !/mask/i.test(f.name))
    .map((f) => ({ name: f.name, label: f.label, required: f.required }))
    .sort((a, b) => Number(b.required) - Number(a.required));
}

/**
 * For first-last-frame video models: the two image fields to fill, identified
 * by 'first'/'last' in their names. Returns null if the model isn't a two-frame
 * model.
 */
export function pickFrameFields(fields: Field[]): { first: string; last: string } | null {
  const imgs = fields.filter((f) => f.kind === 'image');
  // The "end/last" frame field is the tell (e.g. last_frame_url, end_image_url).
  const last = imgs.find((f) => /(^|_)(last|end)/i.test(f.name));
  if (!last) return null;
  // The start frame: an explicit first/start field, else the plain image_url.
  const first =
    imgs.find((f) => f !== last && /(^|_)(first|start)/i.test(f.name)) ??
    imgs.find((f) => f !== last && f.name === 'image_url') ??
    imgs.find((f) => f !== last);
  return first ? { first: first.name, last: last.name } : null;
}

/** A boolean "safety checker" toggle (e.g. FLUX's `enable_safety_checker`). */
function isSafetyCheckerField(f: Field): boolean {
  return f.kind === 'boolean' && /safety[_ ]?checker/i.test(f.name);
}

/**
 * Initial values from each field's default (skips undefined defaults).
 *
 * Policy override: safety-checker toggles default to OFF. Fal's checker
 * (schema default `true`) blocks a lot of plainly SFW prompts, so we opt out by
 * default — but only when the model actually exposes the field, and the user
 * can flip it back on in Advanced.
 */
export function defaultsFor(fields: Field[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (isSafetyCheckerField(f)) {
      out[f.name] = false;
    } else if (f.default !== undefined) {
      out[f.name] = f.default;
    }
  }
  return out;
}
