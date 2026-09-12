// Translates the Miro reference-basket UX onto Fal's positional convention.
//
// Fal has no name-based binding — references are positional (the order of
// `image_urls`), with a couple of models offering numbered tokens instead. This
// layer takes the basket order as given and adapts the prompt per model so that
// ordering is unambiguous to the model.
//
// It deliberately does NOT reorder. An earlier version sorted references by
// where their board title first appeared in the prompt, which made sense when
// the user had no way to express order. Baskets replaced that: the basket *is*
// the order, and the rows are drag-reorderable, so re-deriving it from prose
// silently overrode the one thing the user was directly controlling.
//
// It was also unpredictable. A reference titled "texture" would jump to
// position 1 the moment a prompt said "granite texture" — same basket, a
// different image sent, no indication anything had happened. See the tests.
//
// See docs/REFERENCE-TAGGING-INVESTIGATION.md for the naming investigation.

export type Ref = { url: string; title?: string };
export type BindingResult = { urls: string[]; prompt: string };

type Strategy = 'default' | 'kling' | 'omnigen';

function strategyFor(endpointId: string): Strategy {
  if (/kling/i.test(endpointId)) return 'kling';
  if (/omnigen[-_/]?v?1/i.test(endpointId)) return 'omnigen';
  return 'default';
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Replace each ref's title word with a positional token (Kling / OmniGen). */
function replaceNames(prompt: string, ordered: Ref[], token: (n: number) => string): string {
  let out = prompt;
  ordered.forEach((r, i) => {
    if (!r.title) return;
    out = out.replace(new RegExp(`\\b${escapeRe(r.title)}\\b`, 'gi'), token(i + 1));
  });
  return out;
}

/**
 * Adapt the prompt for the target model, keeping the basket order.
 *
 * - Single-input models: takes the first image in the basket; prompt unchanged.
 * - Multi-input models: sends the basket order as-is and, for the default
 *   strategy, prepends a "Reference image N is NAME." legend so the model knows
 *   which image is which. Kling/OmniGen get their numbered-token rewrites.
 */
export function bindReferences(opts: {
  prompt: string;
  refs: Ref[];
  multiple: boolean;
  endpointId: string;
}): BindingResult {
  const { prompt, refs, multiple, endpointId } = opts;
  if (refs.length === 0) return { urls: [], prompt };

  const urls = refs.map((r) => r.url);

  if (!multiple) {
    return { urls: urls.slice(0, 1), prompt };
  }

  const strategy = strategyFor(endpointId);
  if (strategy === 'kling') {
    return { urls, prompt: replaceNames(prompt, refs, (n) => `@Image${n}`) };
  }
  if (strategy === 'omnigen') {
    return { urls, prompt: replaceNames(prompt, refs, (n) => `<|image_${n}|>`) };
  }

  // Default: prepend a legend for the named references (skip untitled ones).
  const legend = refs
    .map((r, i) => (r.title ? `Reference image ${i + 1} is ${r.title}.` : null))
    .filter((s): s is string => s !== null)
    .join(' ');
  return { urls, prompt: legend ? `${legend} ${prompt}` : prompt };
}

export type SeedanceBinding = {
  image_urls: string[];
  video_urls: string[];
  audio_urls: string[];
  prompt: string;
};

/**
 * Seedance 2.0 reference-to-video binding. Each modality is referenced in the
 * prompt by a positional token — `@Image1`, `@Video1`, `@Audio1`.
 *
 * Basket order is the order sent, for all three modalities. Where the author
 * wrote a board title instead of a token ("the boat drifts left"), that title
 * is rewritten to the token matching its basket position, so naming a thing on
 * the board still works.
 *
 * If the author already wrote explicit tokens ("@Image1 walks left"), nothing
 * is rewritten — they have already said exactly what they mean.
 */
export function bindSeedanceReferences(opts: {
  prompt: string;
  images: Ref[];
  videos?: Ref[];
  audios?: Ref[];
}): SeedanceBinding {
  const { prompt } = opts;
  const images = opts.images ?? [];
  const videos = opts.videos ?? [];
  const audios = opts.audios ?? [];

  // Explicit tokens mean the author has already been unambiguous — leave the
  // prompt alone. Either way the order sent is the basket order.
  const explicit = /@(image|video|audio)\s*\d+/i.test(prompt);

  let out = prompt;
  if (!explicit) {
    out = replaceNames(out, images, (n) => `@Image${n}`);
    out = replaceNames(out, videos, (n) => `@Video${n}`);
    out = replaceNames(out, audios, (n) => `@Audio${n}`);
  }

  return {
    image_urls: images.map((r) => r.url),
    video_urls: videos.map((r) => r.url),
    audio_urls: audios.map((r) => r.url),
    prompt: out,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Reference-to-video: one screen, many dialects.
//
// Every reference-to-video endpoint takes the same three things — images,
// video clips, audio clips — and each one asks for them differently. The
// *field names* are readable from the schema (see pickReferenceField and its
// siblings in shared/schema.ts), so those are never hardcoded. What is not
// readable is how the prompt is supposed to cite a reference: fal states that
// in prose, inside each field's `description`:
//
//   "Refer to them in the prompt as @Video1, @Video2"        (Seedance, Kling)
//   "referenced in the prompt as Image 1, Image 2"           (MiniMax H3, Wan)
//   "using ``character1``, ``character2``"                   (Happy Horse)
//   "Reference in prompt as <IMAGE_0>, <IMAGE_1>"            (Grok — 0-indexed)
//   "Reference media is sent in list order before the prompt" (Gemini Omni)
//
// That is documentation, not data. Parsing it would bind silently and wrongly
// the first time a wording changed, so the dialect is a small explicit table.
//
// It is a refinement, never a gate. An endpoint nobody has classified still
// works — it gets the neutral legend, and its references still land in the
// right fields because those came from the schema. Nothing here has to be
// updated for a new model to function.
// ─────────────────────────────────────────────────────────────────────────────

export type VideoReferenceDialect =
  /** `@Image1` / `@Video1` / `@Audio1` — Seedance, Kling O3. */
  | 'seedance'
  /** `Image 1` / `Video 1` — MiniMax H3, Wan 3.x. */
  | 'positional'
  /** `character1` — Happy Horse; subjects only. */
  | 'character'
  /** `<IMAGE_0>` — Grok Imagine; images only, and zero-indexed. */
  | 'bracket'
  /** No token scheme published: prepend a naming legend and hope. */
  | 'legend'
  /** The model reads references by list order; touching the prompt only hurts. */
  | 'none';

/** The dialect an endpoint speaks. Order matters — first match wins. */
export function videoReferenceDialect(endpointId: string): VideoReferenceDialect {
  // Blended "ingredients" and list-order models: no addressing scheme at all.
  if (/veo/i.test(endpointId)) return 'none';
  if (/gemini-omni/i.test(endpointId)) return 'none';
  if (/seedance|kling/i.test(endpointId)) return 'seedance';
  if (/happy-horse/i.test(endpointId)) return 'character';
  if (/grok/i.test(endpointId)) return 'bracket';
  if (/minimax|(^|[^a-z])h3([^a-z]|$)|wan-?3/i.test(endpointId)) return 'positional';
  return 'legend';
}

export type VideoReferenceCaps = { images: number; videos: number; audios: number };

/**
 * How many of each modality an endpoint accepts.
 *
 * Prose again ("up to 9 images", "Maximum 7 images", "at most 12 files"), so
 * again a table. The default is the common 9/3/3 shape rather than something
 * timid: truncating a basket the model would have accepted is a worse failure
 * than letting the model reject it with a clear message, because the former is
 * invisible.
 */
export function videoReferenceCaps(endpointId: string): VideoReferenceCaps {
  if (/veo/i.test(endpointId)) return { images: 3, videos: 0, audios: 0 };
  if (/seedance-2\.5/i.test(endpointId)) return { images: 30, videos: 10, audios: 10 };
  if (/seedance/i.test(endpointId)) return { images: 9, videos: 3, audios: 3 };
  if (/kling/i.test(endpointId)) return { images: 4, videos: 0, audios: 0 };
  if (/grok/i.test(endpointId)) return { images: 7, videos: 0, audios: 0 };
  if (/happy-horse/i.test(endpointId)) return { images: 9, videos: 0, audios: 0 };
  if (/wan-?3/i.test(endpointId)) return { images: 10, videos: 5, audios: 5 };
  return { images: 9, videos: 3, audios: 3 };
}

export type VideoBinding = {
  prompt: string;
  images: string[];
  videos: string[];
  audios: string[];
};

/** Has the author already written this dialect's tokens by hand? */
function alreadyExplicit(dialect: VideoReferenceDialect, prompt: string): boolean {
  switch (dialect) {
    case 'seedance':
      return /@(image|video|audio)\s*\d+/i.test(prompt);
    case 'positional':
      return /\b(image|video|audio)\s+\d+\b/i.test(prompt);
    case 'character':
      return /\bcharacter\s*\d+\b/i.test(prompt);
    case 'bracket':
      return /<\s*(image|video|audio)_\d+\s*>/i.test(prompt);
    default:
      return false;
  }
}

/**
 * Bind references for any reference-to-video model: basket order is preserved
 * for every modality, and the prompt is adapted to the model's own dialect.
 *
 * Returns URLs per modality rather than named fields — the caller assigns them
 * to the field names it read off the schema, which is the half of this problem
 * that must not be hardcoded.
 */
export function bindVideoReferences(opts: {
  endpointId: string;
  prompt: string;
  images?: Ref[];
  videos?: Ref[];
  audios?: Ref[];
}): VideoBinding {
  const images = opts.images ?? [];
  const videos = opts.videos ?? [];
  const audios = opts.audios ?? [];
  const urls = {
    images: images.map((r) => r.url),
    videos: videos.map((r) => r.url),
    audios: audios.map((r) => r.url),
  };

  const dialect = videoReferenceDialect(opts.endpointId);

  // Seedance/Kling keep going through the original binder so their behaviour
  // — and the tests pinning it — stay exactly as they were.
  if (dialect === 'seedance') {
    const bound = bindSeedanceReferences({ prompt: opts.prompt, images, videos, audios });
    return { prompt: bound.prompt, ...urls };
  }

  if (dialect === 'none') return { prompt: opts.prompt, ...urls };

  if (alreadyExplicit(dialect, opts.prompt)) return { prompt: opts.prompt, ...urls };

  let out = opts.prompt;
  switch (dialect) {
    case 'positional':
      out = replaceNames(out, images, (n) => `Image ${n}`);
      out = replaceNames(out, videos, (n) => `Video ${n}`);
      out = replaceNames(out, audios, (n) => `Audio ${n}`);
      break;
    case 'character':
      // Happy Horse addresses subjects only; it has no video/audio references.
      out = replaceNames(out, images, (n) => `character${n}`);
      break;
    case 'bracket':
      // Grok counts from zero, so basket position 1 is <IMAGE_0>.
      out = replaceNames(out, images, (n) => `<IMAGE_${n - 1}>`);
      break;
    case 'legend': {
      const legend = images
        .map((r, i) => (r.title ? `Reference image ${i + 1} is ${r.title}.` : null))
        .filter((s): s is string => s !== null)
        .join(' ');
      out = legend ? `${legend} ${out}` : out;
      break;
    }
  }
  return { prompt: out, ...urls };
}

/**
 * The token this dialect uses for row `index` (0-based) of a modality — the
 * text shown on a basket chip and inserted into the prompt when it is clicked.
 *
 * Lives here rather than in the panel so there is exactly one place that knows
 * a dialect's spelling: the binder that rewrites prompts and the chip that
 * teaches people how to write them can never disagree.
 *
 * Returns null when the dialect has no way to address a reference from the
 * prompt, or cannot address this modality (Happy Horse and Grok take images
 * only) — the caller should then show no chip rather than a misleading one.
 */
export function videoReferenceToken(
  dialect: VideoReferenceDialect,
  kind: 'image' | 'video' | 'audio',
  index: number,
): string | null {
  const n = index + 1;
  const Cap = kind === 'image' ? 'Image' : kind === 'video' ? 'Video' : 'Audio';
  switch (dialect) {
    case 'seedance':
      return `@${Cap}${n}`;
    case 'positional':
      return `${Cap} ${n}`;
    case 'character':
      return kind === 'image' ? `character${n}` : null;
    case 'bracket':
      return kind === 'image' ? `<IMAGE_${index}>` : null;
    default:
      return null;
  }
}
