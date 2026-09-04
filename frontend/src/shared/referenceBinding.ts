// Translates the Miro "named references" UX onto Fal's positional convention.
//
// Runway binds image titles to @tags in the prompt. Fal has no name-based
// binding — references are positional (order of `image_urls`), with two models
// offering numbered tokens. This layer orders the images by first mention of
// their title in the prompt, then adapts the prompt per model so the ordering
// is unambiguous. See docs/REFERENCE-TAGGING-INVESTIGATION.md.

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

/** Character index of the first whole-word mention of `title`, or Infinity. */
function mentionIndex(prompt: string, title?: string): number {
  if (!title) return Infinity;
  const m = prompt.match(new RegExp(`\\b${escapeRe(title)}\\b`, 'i'));
  return m && typeof m.index === 'number' ? m.index : Infinity;
}

/** Stable-sort refs by where their title is first mentioned in the prompt. */
function orderByMention(prompt: string, refs: Ref[]): Ref[] {
  return refs
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      const ma = mentionIndex(prompt, a.r.title);
      const mb = mentionIndex(prompt, b.r.title);
      return ma !== mb ? ma - mb : a.i - b.i;
    })
    .map((x) => x.r);
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
 * Order the reference images and adapt the prompt for the target model.
 *
 * - Single-input models: returns just the first (most-relevant, by mention)
 *   image; prompt unchanged.
 * - Multi-input models: orders all images by mention and, for the default
 *   strategy, prepends a "Reference image N is NAME." legend. Kling/OmniGen get
 *   their numbered-token rewrites instead.
 */
export function bindReferences(opts: {
  prompt: string;
  refs: Ref[];
  multiple: boolean;
  endpointId: string;
}): BindingResult {
  const { prompt, refs, multiple, endpointId } = opts;
  if (refs.length === 0) return { urls: [], prompt };

  const ordered = orderByMention(prompt, refs);
  const urls = ordered.map((r) => r.url);

  if (!multiple) {
    return { urls: urls.slice(0, 1), prompt };
  }

  const strategy = strategyFor(endpointId);
  if (strategy === 'kling') {
    return { urls, prompt: replaceNames(prompt, ordered, (n) => `@Image${n}`) };
  }
  if (strategy === 'omnigen') {
    return { urls, prompt: replaceNames(prompt, ordered, (n) => `<|image_${n}|>`) };
  }

  // Default: prepend a legend for the named references (skip untitled ones).
  const legend = ordered
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
 * prompt by a positional token — `@Image1`, `@Video1`, `@Audio1` — so we order
 * each list by first mention of its board title and rewrite those titles into
 * the matching tokens (the same "name it on the board, name it in the prompt"
 * UX as the image models).
 *
 * If the author already wrote explicit tokens (e.g. "@Image1 walks left"), we
 * take that as intent and keep the given order untouched.
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

  const explicit = /@(image|video|audio)\s*\d+/i.test(prompt);

  const orderedImages = explicit ? images : orderByMention(prompt, images);
  const orderedVideos = explicit ? videos : orderByMention(prompt, videos);
  const orderedAudios = explicit ? audios : orderByMention(prompt, audios);

  let out = prompt;
  if (!explicit) {
    out = replaceNames(out, orderedImages, (n) => `@Image${n}`);
    out = replaceNames(out, orderedVideos, (n) => `@Video${n}`);
    out = replaceNames(out, orderedAudios, (n) => `@Audio${n}`);
  }

  return {
    image_urls: orderedImages.map((r) => r.url),
    video_urls: orderedVideos.map((r) => r.url),
    audio_urls: orderedAudios.map((r) => r.url),
    prompt: out,
  };
}
