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
