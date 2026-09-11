// The model catalog. There is no hand-maintained model list here — the
// catalog IS fal's, synced at runtime from /api/fal/models and cached in
// localStorage between sessions. Models change faster than a checked-in list
// can track, so nothing in this file names a model you have to keep updating.
//
// What this file does own:
//   • mapping fal's `category` → this app's capability + which screen opens
//     (FAL_CATEGORY_MAP);
//   • a short list of per-endpoint behaviour overrides for the handful of
//     endpoints with a bespoke screen that fal's metadata can't describe
//     (ENDPOINT_OVERRIDES / EXTRA_TASKS below);
//   • the Provider ▸ Model(family) ▸ Task browse grouping, derived from the
//     synced metadata rather than declared per model.
//
// Input controls are generated at runtime from each model's live OpenAPI
// schema (via the backend /api/fal/schema route), split into the
// "always-shown" common tier at the bottom of this file and a generic
// "Advanced" section.

export type Capability =
  | 'image'
  | 'video'
  | 'audio'
  | 'music'
  | 'segment'
  | 'model3d'
  | 'panorama'
  | 'rig'
  // Text → skeletal animation (Hunyuan Motion): an FBX clip on a mannequin.
  | 'motion'
  | 'sound'
  | 'merge'
  // Long-tail synced categories (LLM, vision, training data, workflows…) that
  // used to have no icon/tone of their own and silently fell back to
  // 'image' — see capabilityForCategory and FAL_CATEGORY_MAP.
  | 'llm'
  | 'vision'
  | 'data'
  | 'training'
  | 'workflow'
  | 'other';

export type FalModel = {
  /** Fal endpoint id, e.g. "fal-ai/nano-banana/edit". */
  endpointId: string;
  /** Consumer-friendly label shown on the (searchable) home screen. */
  label: string;
  capability: Capability;
  /** Video model that takes two frames (first/start + last/end) → two-slot screen. */
  twoFrame?: boolean;
  /**
   * Text-to-image generator: force text-primary (image never required) even if
   * the schema marks an image field required. Selected/connected stickies drive
   * the prompt; any image stays optional.
   */
  generate?: boolean;
  /** Model family this endpoint belongs to (groups task variants). e.g. "Veo 3.1". */
  family?: string;
  /** Task label within the family. e.g. "Image to Video", "Edit", "Generate". */
  task?: string;
  /** Category label, mapped from fal's own `category` (see FAL_CATEGORY_MAP). */
  category?: string;
  /** Force the generic schema screen (long-tail: audio, LLM, training…). */
  screen?: 'generic';
  /** Model thumbnail from fal metadata, if any. */
  thumbnailUrl?: string;
};

// ---------------------------------------------------------------------------
// Per-endpoint behaviour overrides.
//
// NOT a model list. These are the routing flags that decide which *screen* an
// endpoint opens, for the handful of endpoints this app has a bespoke screen
// for. fal's metadata has no way to express "this one opens the rigging
// screen" or "this one takes two frames", so those few facts live here.
// Matched by pattern against the synced catalog — an endpoint fal retires
// simply stops matching, and a new one fal adds needs no change here unless
// it wants a bespoke screen.
// ---------------------------------------------------------------------------
// Capability only — never `category`. categoryOf() derives the category label
// from the capability, and those derived labels are the ones
// DEFAULT_MEDIA_CATEGORIES ships with; writing a prettier category here (e.g.
// "Extract object" for segmentation) would put the model in a category the
// default curation filter doesn't allow, and silently hide it.
//
// `whenCategory` is what keeps these honest. A name pattern alone is far too
// blunt on a 1,500-model catalog: "sam-3" also matches `sam-3/3d-body` and
// `sam-3/video`, "hunyuan_world" also matches `hunyuan_world/image-to-world`,
// and every "interpolate" pattern also matches two LoRA trainers. Gating on
// fal's own category makes each rule say what it actually means — "a SAM
// endpoint that takes an image and returns an image" — instead of "anything
// with SAM in the name".
type EndpointOverride = {
  match: RegExp;
  /** Only apply when fal's own category is exactly this. */
  whenCategory?: string;
  /** Escape hatch for a sibling the pattern catches but shouldn't. */
  exclude?: RegExp;
  apply: Partial<FalModel>;
  task?: string;
};

const ENDPOINT_OVERRIDES: EndpointOverride[] = [
  // Segmentation → cutout-on-board screen. The `-rle` twins return run-length
  // encoding rather than an image, so they stay on the generic form.
  {
    match: /\/sam-\d|\bevf-sam\b/i,
    whenCategory: 'image-to-image',
    exclude: /-rle$/i,
    apply: { capability: 'segment' },
    task: 'Extract object',
  },
  // Equirectangular 360° output → photosphere embed. Not `image-to-world`,
  // which is a 3D scene rather than a panorama.
  {
    match: /hunyuan_world|to-panorama/i,
    whenCategory: 'image-to-image',
    apply: { capability: 'panorama' },
    task: 'Image to Panorama',
  },
  // Rig + animate a character → animated viewer embed. fal files these under
  // `3d-to-3d`, which carries no hint that a rigging screen is wanted.
  { match: /rigging/i, apply: { capability: 'rig' }, task: 'Rig + Animate' },
  // Text → human motion as an FBX clip. fal files it under `text-to-3d`, which
  // would send it to the generic form and then fail on the .fbx output.
  { match: /hunyuan-motion/i, apply: { capability: 'motion', generate: true }, task: 'Text to Motion' },
  // The two FFmpeg merges this app has screens for. `merge-audios` is a third
  // one with no screen, so it is deliberately not matched.
  {
    match: /ffmpeg-api\/(merge-videos|merge-audio-video)$/i,
    apply: { capability: 'merge' },
    task: 'Merge',
  },
  // Video → soundtrack. fal categorises these as `video-to-video` (they return
  // the same video with audio muxed in), so without this they land on the
  // video form and ask for a video URL instead of offering the board's video
  // embeds. The genuinely `video-to-audio` models need no override —
  // FAL_CATEGORY_MAP already maps that category to `sound`.
  {
    match: /thinksound|mmaudio|foley/i,
    whenCategory: 'video-to-video',
    apply: { capability: 'sound' },
    task: 'Video to Sound',
  },
  // Two stills in, one video out → the start/end screen rather than the
  // single-image form. Every vendor names this differently: first-last-frame
  // (Veo, Flux 3), start-end (Vidu), flf2v (Framepack, Wan), keyframes
  // (Flux 3), transition (PixVerse), frame-interpolation (AMT). Gating on
  // `image-to-video` is what excludes the LoRA trainers and the
  // video-to-video interpolators that share those words.
  {
    match: /first-last|start-end|flf2v|keyframes-to-video|\/transition$|frame-interpolation/i,
    whenCategory: 'image-to-video',
    apply: { capability: 'video', twoFrame: true },
    task: 'First + Last',
  },
];

/**
 * Extra UI variants for an endpoint fal lists exactly once.
 *
 * Some video endpoints accept either one image or a start+end pair — same
 * endpoint, two different screens. That is a property of this app's UI, not
 * of the model, so fal's catalog has no field for it. Each entry here adds a
 * second browsable task for an endpoint, and only if the sync actually
 * returned that endpoint.
 */
const EXTRA_TASKS: Array<{ match: RegExp; task: string; apply: Partial<FalModel> }> = [
  { match: /seedance.*\/image-to-video$/i, task: 'Start + End', apply: { twoFrame: true } },
];

// ---------------------------------------------------------------------------
// Curation filter — an allowlist of providers and categories the user wants to
// see (null = all). Kept in module state so the synchronous browse helpers can
// read it; persisted separately (storage.getCatalogFilter) and pushed in on app
// start / when Settings saves. Training et al. are hidden by *choice*, not code.
// ---------------------------------------------------------------------------
export type CatalogFilter = { providers: string[] | null; categories: string[] | null };

// Media categories shown by default once the full fal catalog is synced. The
// long tail (Training, LLM, Vision, Speech to Text, Audio to Audio) is hidden
// by default but toggle-able in Settings — nothing is excluded by code.
export const DEFAULT_MEDIA_CATEGORIES = [
  'Text to Image',
  'Image to Image',
  'Text to Video',
  'Image to Video',
  'Video to Video',
  'Audio to Video',
  'Image to 3D',
  'Text to 3D',
  'Image to Panorama',
  'Text to Audio',
  'Text to Speech',
  'Rig & Animate',
  'Text to Motion',
  'Video to Audio',
  'Video editing',
];
export const DEFAULT_CATALOG_FILTER: CatalogFilter = { providers: null, categories: DEFAULT_MEDIA_CATEGORIES };

let activeFilter: CatalogFilter = DEFAULT_CATALOG_FILTER;
const catalogListeners = new Set<() => void>();

// Cache of the last successful catalog sync (see mergeSyncedCatalog below) —
// read synchronously at module init so a *returning* user sees the catalog
// immediately while api.getModels() re-fetches in the background (App.tsx).
// With no hand-maintained fallback list, this cache is the only thing between
// a returning user and an empty screen, so it matters more than it used to.
// The first-ever load per browser has nothing cached and shows App's loading
// screen until the sync lands. No staleness check: even a week-old cache is a
// fine instant placeholder, since the background refresh always overwrites it
// within seconds anyway.
const CATALOG_CACHE_KEY = 'fal:catalogCache';

function readCachedSyncedModels(): SyncedMeta[] | null {
  try {
    const raw = localStorage.getItem(CATALOG_CACHE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed?.models) ? (parsed.models as SyncedMeta[]) : null;
  } catch {
    return null;
  }
}

/** Persist a fresh catalog sync for next load — see readCachedSyncedModels. */
export function cacheSyncedModels(models: SyncedMeta[]): void {
  try {
    localStorage.setItem(CATALOG_CACHE_KEY, JSON.stringify({ at: Date.now(), models }));
  } catch (e) {
    console.warn('[falCatalog] cacheSyncedModels failed:', e);
  }
}

// The live model set. Starts empty — there is no built-in list any more — and
// is filled either from a cached sync (applied further down this file, once
// mergeSyncedCatalog and what it depends on are defined; calling it up here
// would hit the temporal dead zone) or by the first successful sync. Browse
// helpers read this.
let activeModels: FalModel[] = [];
export function setActiveModels(models: FalModel[]): void {
  activeModels = models;
  catalogListeners.forEach((l) => l());
}

// Whether the browsable catalog is settled — either a cached sync was applied
// at init, or the first real sync attempt (success or failure) has completed.
// Drives App.tsx's loading screen: with no built-in list there is nothing to
// show before the sync lands, so a first-ever-load user sees a loading state
// until this flips true.
let catalogReady = false;
export function isCatalogReady(): boolean {
  return catalogReady;
}
/** Mark the catalog settled (call once the sync promise resolves OR rejects). */
export function markCatalogReady(): void {
  catalogReady = true;
  catalogListeners.forEach((l) => l());
}

export function setActiveCatalogFilter(filter: CatalogFilter): void {
  activeFilter = filter;
  catalogListeners.forEach((l) => l());
}
export function getActiveCatalogFilter(): CatalogFilter {
  return activeFilter;
}
/** Subscribe to filter changes (returns an unsubscribe). */
export function subscribeCatalog(cb: () => void): () => void {
  catalogListeners.add(cb);
  return () => {
    catalogListeners.delete(cb);
  };
}

/** Models shown in the UI — the synced catalog with the curation filter applied. */
export function enabledModels(): FalModel[] {
  let list: FalModel[] = activeModels;
  if (activeFilter.providers) {
    const allow = new Set(activeFilter.providers);
    list = list.filter((m) => allow.has(providerOf(m.endpointId)));
  }
  if (activeFilter.categories) {
    const allow = new Set(activeFilter.categories);
    list = list.filter((m) => allow.has(categoryOf(m)));
  }
  return list;
}

/** All providers/categories present in the FULL catalog (ignoring the filter) —
 *  the toggle universe for the Settings page. */
export function allProviders(): string[] {
  const set = new Set<string>();
  const base = activeModels;
  for (const m of base) set.add(providerOf(m.endpointId));
  return [...set].sort();
}
export function allCategories(): string[] {
  const base = activeModels;
  const present = new Set(base.map((m) => categoryOf(m)));
  // Known categories first (in display order), then any extras alphabetically.
  const known = CATEGORY_ORDER.filter((c) => present.has(c));
  const extra = [...present].filter((c) => !CATEGORY_ORDER.includes(c)).sort();
  return [...known, ...extra];
}

export function modelsByCapability(capability: Capability): FalModel[] {
  return enabledModels().filter((m) => m.capability === capability);
}

export function findModel(endpointId: string): FalModel | undefined {
  // Search the whole synced catalog, not just what the current curation
  // filter shows — a settings card can reference a long-tail model.
  return activeModels.find((m) => m.endpointId === endpointId);
}

/** Reference-to-video: driven by the multi-reference picker (Seedance / Veo). */
export function isReferenceToVideo(model: FalModel): boolean {
  return model.capability === 'video' && /reference-to-video/i.test(model.endpointId);
}

/**
 * Blend-style reference-to-video (Veo "ingredients"): images only, blended into
 * one scene with no per-image @token addressing. Seedance is the addressable,
 * multimodal alternative.
 */
export function isBlendReference(model: FalModel): boolean {
  return isReferenceToVideo(model) && /veo/i.test(model.endpointId);
}

// The underlying model maker (not the fal-ai hosting prefix) — for the "browse
// by Provider" home. Order matters: more specific patterns first.
const PROVIDER_RULES: Array<[RegExp, string]> = [
  [/nano-banana|gemini|veo|imagen|lyria/i, 'Google'],
  [/flux/i, 'Black Forest Labs'],
  [/seedance|seedream|bytedance/i, 'ByteDance'],
  [/hunyuan|tencent/i, 'Tencent'],
  [/meshy/i, 'Meshy'],
  [/sam-\d|evf-sam|\bsam\b/i, 'Meta'],
  [/triposr|stable-|stability|sd3|sdxl/i, 'Stability AI'],
  [/kling|kuaishou/i, 'Kling'],
  [/minimax|hailuo/i, 'MiniMax'],
  [/\bluma\b|ray-?\d|photon/i, 'Luma'],
  [/ideogram/i, 'Ideogram'],
  [/\bwan\b|qwen|alibaba/i, 'Alibaba'],
  [/recraft/i, 'Recraft'],
  [/elevenlabs|eleven-/i, 'ElevenLabs'],
  [/\bltx|lightricks/i, 'Lightricks'],
  [/\bbria\b/i, 'Bria'],
  [/\bveed\b/i, 'VEED'],
  [/\bxai\b|grok/i, 'xAI'],
  [/openai|gpt-|dall-?e|sora/i, 'OpenAI'],
  [/runway|gen-?\d/i, 'Runway'],
  [/\bpika\b/i, 'Pika'],
  [/topaz/i, 'Topaz'],
  [/ffmpeg/i, 'Fal'],
];

/** Prettify a vendor-namespaced endpoint's first segment (e.g. "pixverse/…"). */
function providerFromNamespace(endpointId: string): string {
  const seg = endpointId.split('/')[0] ?? '';
  const token = seg.split(/[-_]/)[0];
  if (!token) return 'Other';
  return token.charAt(0).toUpperCase() + token.slice(1);
}

export function providerOf(endpointId: string): string {
  for (const [re, name] of PROVIDER_RULES) if (re.test(endpointId)) return name;
  // Vendor-namespaced endpoints ("vendor/model/…") carry the vendor up front.
  // Anything under fal-ai/ without a rule match is a model-type namespace, not
  // a lab — bucket it as "Other" rather than inventing junk providers.
  if (!/^fal-ai\//.test(endpointId) && endpointId.includes('/')) return providerFromNamespace(endpointId);
  return 'Other';
}

export function modelsByProvider(provider: string): FalModel[] {
  return enabledModels().filter((m) => providerOf(m.endpointId) === provider);
}

// ---------------------------------------------------------------------------
// Family (= "the model") + Task grouping, and the fal-style Category axis.
// ---------------------------------------------------------------------------

/** Task label for an entry (explicit `task`, else derived from the label). */
export function taskOf(m: FalModel): string {
  if (m.task) return m.task;
  const dot = m.label.indexOf(' · ');
  if (dot >= 0) return m.label.slice(dot + 3).trim();
  const paren = m.label.match(/\(([^)]+)\)/);
  if (paren) return paren[1].trim();
  return CAPABILITY_LABEL[m.capability];
}

/** Family/display name for an entry (explicit `family`, else derived). */
export function familyOf(m: FalModel): string {
  if (m.family) return m.family;
  const cut = m.label.search(/ [·([]/);
  return (cut > 0 ? m.label.slice(0, cut) : m.label).trim();
}

/** fal-style input→output category (explicit for synced models, else derived). */
export function categoryOf(m: FalModel): string {
  if (m.category) return m.category;
  switch (m.capability) {
    case 'image':
      return m.generate ? 'Text to Image' : 'Image to Image';
    case 'video':
      return 'Image to Video';
    case 'segment':
      return 'Image to Image';
    case 'model3d':
      return 'Image to 3D';
    case 'panorama':
      return 'Image to Panorama';
    case 'rig':
      return 'Rig & Animate';
    case 'motion':
      return 'Text to Motion';
    case 'sound':
      return 'Video to Audio';
    case 'audio':
      return 'Text to Speech';
    case 'music':
      return 'Text to Audio';
    case 'merge':
      return 'Video editing';
    default:
      return 'Other';
  }
}

const CATEGORY_ORDER = [
  'Text to Image',
  'Image to Image',
  'Image to Video',
  'Image to 3D',
  'Image to Panorama',
  'Rig & Animate',
  'Video to Audio',
  'Text to Audio',
  'Text to Speech',
  'Video editing',
  'Other',
];

/** A representative capability for a category — powers its tone/icon in the UI. */
export function capabilityForCategory(category: string): Capability {
  switch (category) {
    case 'Text to Image':
    case 'Image to Image':
      return 'image';
    case 'Image to Video':
    case 'Text to Video':
    case 'Video to Video':
    case 'Audio to Video':
      return 'video';
    case 'Image to 3D':
    case 'Text to 3D':
    case '3d To 3d':
      return 'model3d';
    case 'Image to Panorama':
      return 'panorama';
    case 'Rig & Animate':
      return 'rig';
    case 'Text to Motion':
      return 'motion';
    case 'Video to Audio':
      return 'sound';
    case 'Text to Audio':
      return 'music';
    case 'Text to Speech':
    case 'Speech to Text':
    case 'Audio To Text': // titleCaseKebab capitalizes every word ("To"), unlike
    case 'Audio to Audio': //  the hand-written labels above — see FAL_CATEGORY_MAP.
    case 'Speech To Speech':
      return 'audio';
    case 'Video editing':
      return 'merge';
    case 'LLM':
      return 'llm';
    case 'Vision':
    case 'Image To Text':
    case 'Video To Text':
      return 'vision';
    case 'Image To Json':
    case 'Text To Json':
    case 'Json':
      return 'data';
    case 'Training':
      return 'training';
    case 'Workflow':
      return 'workflow';
    case 'Unknown':
      return 'other';
    default:
      return 'other';
  }
}

export type ModelFamily = {
  /** Unique key (= family name). */
  key: string;
  name: string;
  provider: string;
  /** Distinct capabilities among the family's tasks (first drives the tone). */
  capabilities: Capability[];
  /** Distinct fal-style categories among the family's tasks. */
  categories: string[];
  /** The task variants, in catalog order. */
  tasks: FalModel[];
};

/** Group a set of models into families, preserving order. */
function familiesFrom(models: FalModel[]): ModelFamily[] {
  const byKey = new Map<string, ModelFamily>();
  for (const m of models) {
    const key = familyOf(m);
    let fam = byKey.get(key);
    if (!fam) {
      fam = { key, name: key, provider: providerOf(m.endpointId), capabilities: [], categories: [], tasks: [] };
      byKey.set(key, fam);
    }
    fam.tasks.push(m);
    if (!fam.capabilities.includes(m.capability)) fam.capabilities.push(m.capability);
    const cat = categoryOf(m);
    if (!fam.categories.includes(cat)) fam.categories.push(cat);
  }
  return [...byKey.values()];
}

/** Group the enabled (curated) models into families. */
export function modelFamilies(): ModelFamily[] {
  return familiesFrom(enabledModels());
}

// ---------------------------------------------------------------------------
// Favourites — a per-board set of family keys, kept in module state (persisted
// via storage.getFavourites/setFavourites, loaded on app start). Favourites
// always show, even when the curation filter would otherwise hide them.
// ---------------------------------------------------------------------------
let favourites = new Set<string>();

export function applyFavourites(keys: string[]): void {
  favourites = new Set(keys);
  catalogListeners.forEach((l) => l());
}
export function getFavouriteKeys(): string[] {
  return [...favourites];
}
export function isFavourite(key: string): boolean {
  return favourites.has(key);
}
/** Toggle a family's favourite state; returns the new state. */
export function toggleFavouriteState(key: string): boolean {
  if (favourites.has(key)) favourites.delete(key);
  else favourites.add(key);
  catalogListeners.forEach((l) => l());
  return favourites.has(key);
}
/** Favourited families (bypasses the curation filter — a favourite always shows). */
export function favouriteFamilies(): ModelFamily[] {
  if (favourites.size === 0) return [];
  const base = activeModels;
  return familiesFrom(base).filter((f) => favourites.has(f.key));
}

export function familyByKey(key: string): ModelFamily | undefined {
  return modelFamilies().find((f) => f.key === key);
}

export function familiesByProvider(provider: string): ModelFamily[] {
  return modelFamilies().filter((f) => f.provider === provider);
}

export function familiesByCategory(category: string): ModelFamily[] {
  return modelFamilies().filter((f) => f.categories.includes(category));
}

/** Distinct providers present, ordered by how many models (families) each has. */
export function providersPresent(): string[] {
  const counts = new Map<string, number>();
  for (const f of modelFamilies()) counts.set(f.provider, (counts.get(f.provider) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p);
}

/** Categories that have at least one family, in a stable display order. */
export function categoriesPresent(): string[] {
  const present = new Set(enabledModels().map((m) => categoryOf(m)));
  const known = CATEGORY_ORDER.filter((c) => present.has(c));
  const extra = [...present].filter((c) => !CATEGORY_ORDER.includes(c)).sort();
  return [...known, ...extra];
}

// ---------------------------------------------------------------------------
// Synced catalog — fal's Models metadata IS the catalog. Each model maps its
// fal category → this app's capability + screen; the long tail (audio, LLM,
// training…) routes to the generic schema screen. ENDPOINT_OVERRIDES near the
// top of this file then corrects the few with a bespoke screen.
// ---------------------------------------------------------------------------
type CategoryMapping = { label: string; capability: Capability; generate?: boolean; screen?: 'generic' };

const FAL_CATEGORY_MAP: Record<string, CategoryMapping> = {
  'text-to-image': { label: 'Text to Image', capability: 'image', generate: true },
  'image-to-image': { label: 'Image to Image', capability: 'image' },
  'text-to-video': { label: 'Text to Video', capability: 'video', generate: true },
  'image-to-video': { label: 'Image to Video', capability: 'video' },
  'video-to-video': { label: 'Video to Video', capability: 'video' },
  'audio-to-video': { label: 'Audio to Video', capability: 'video' },
  'video-to-audio': { label: 'Video to Audio', capability: 'sound' },
  'image-to-3d': { label: 'Image to 3D', capability: 'model3d' },
  // Remesh / retexture / part-splitting, plus Meshy's rigging (rescued by an
  // override above). Without this they fall to the default mapping and show up
  // as an image model called "3d To 3d".
  '3d-to-3d': { label: '3D to 3D', capability: 'model3d', screen: 'generic' },
  'text-to-3d': { label: 'Text to 3D', capability: 'model3d', generate: true, screen: 'generic' },
  'text-to-audio': { label: 'Text to Audio', capability: 'music', generate: true, screen: 'generic' },
  'text-to-speech': { label: 'Text to Speech', capability: 'audio', generate: true, screen: 'generic' },
  'audio-to-audio': { label: 'Audio to Audio', capability: 'audio', screen: 'generic' },
  'speech-to-text': { label: 'Speech to Text', capability: 'audio', screen: 'generic' },
  vision: { label: 'Vision', capability: 'vision', screen: 'generic' },
  llm: { label: 'LLM', capability: 'llm', screen: 'generic' },
  training: { label: 'Training', capability: 'training', screen: 'generic' },
};

function titleCaseKebab(s: string): string {
  return s
    .split('-')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function mapFalCategory(category: string): CategoryMapping {
  return FAL_CATEGORY_MAP[category] ?? { label: titleCaseKebab(category) || 'Other', capability: 'image', screen: 'generic' };
}

export type SyncedMeta = {
  endpointId: string;
  displayName: string | null;
  category: string | null;
  tags: string[];
  status: string | null;
  thumbnailUrl: string | null;
};

/**
 * Turn fal's synced metadata into the browsable catalog.
 *
 * This is the whole catalog — there is no hand list to merge over any more.
 * Each entry's capability/screen comes from fal's own `category`, then
 * ENDPOINT_OVERRIDES corrects the handful that need a bespoke screen, and
 * EXTRA_TASKS adds the second UI variant for endpoints that have one.
 */
export function mergeSyncedCatalog(meta: SyncedMeta[]): FalModel[] {
  const out: FalModel[] = [];
  const seen = new Set<string>();
  for (const m of meta) {
    if (!m.endpointId || seen.has(m.endpointId)) continue;
    if (m.status && m.status !== 'active') continue;
    seen.add(m.endpointId);

    const falCategory = (m.category ?? '').toLowerCase();
    const mapped = mapFalCategory(falCategory);
    const name = m.displayName?.trim() || m.endpointId;
    const base: FalModel = {
      endpointId: m.endpointId,
      label: name,
      capability: mapped.capability,
      category: mapped.label,
      family: name,
      task: mapped.label,
      ...(mapped.generate ? { generate: true } : {}),
      ...(mapped.screen ? { screen: mapped.screen } : {}),
      ...(m.thumbnailUrl ? { thumbnailUrl: m.thumbnailUrl } : {}),
    };

    // A bespoke screen wins over the category-derived default, and clears
    // both `screen: 'generic'` (that flag routes the long tail into the
    // generic form, which is exactly what an override opts out of) and
    // `category` (so categoryOf derives it from the new capability — see the
    // note on ENDPOINT_OVERRIDES).
    for (const o of ENDPOINT_OVERRIDES) {
      if (!o.match.test(m.endpointId)) continue;
      if (o.whenCategory && o.whenCategory !== falCategory) continue;
      if (o.exclude?.test(m.endpointId)) continue;
      Object.assign(base, o.apply, { screen: undefined, category: undefined, task: o.task ?? base.task });
    }
    out.push(base);

    for (const extra of EXTRA_TASKS) {
      if (!extra.match.test(m.endpointId)) continue;
      out.push({ ...base, ...extra.apply, task: extra.task, label: `${name} · ${extra.task}` });
    }
  }
  return out;
}

// Apply a cached sync from a previous session now that mergeSyncedCatalog
// (and FAL_CATEGORY_MAP/mapFalCategory, which it depends on) are actually
// defined — see the `activeModels` comment near the top of this file for why
// this can't happen any earlier. No-op on the first-ever load, when there's
// nothing cached yet — App.tsx's loading screen covers that gap instead.
{
  const cachedSyncedModels = readCachedSyncedModels();
  if (cachedSyncedModels) {
    setActiveModels(mergeSyncedCatalog(cachedSyncedModels));
    catalogReady = true;
  }
}

// Short labels used for capability chips/icons (also the task fallback).
const CAPABILITY_LABEL: Record<Capability, string> = {
  image: 'Image',
  video: 'Video',
  audio: 'Audio',
  music: 'Music',
  segment: 'Extract',
  model3d: '3D',
  panorama: 'Panorama',
  rig: 'Rig',
  motion: 'Motion',
  sound: 'Sound',
  merge: 'Merge',
  llm: 'LLM',
  vision: 'Vision',
  data: 'Data',
  training: 'Training',
  workflow: 'Workflow',
  other: 'Other',
};

// ---------------------------------------------------------------------------
// "Always-shown" common arguments per capability (from the agreed spec).
//
// These names are matched against the model's OpenAPI schema at render time:
// a field listed here is shown up-front (bound to the schema's enum/range);
// everything else in the schema collapses under "Advanced". Names absent from
// a given model's schema are simply skipped.
// ---------------------------------------------------------------------------

export const COMMON_ARGS: Record<Capability, string[]> = {
  // `strength` is the key image-to-image knob (low = preserve the source,
  // high = regenerate from the prompt) — surface it up-front when present.
  image: ['prompt', 'image_size', 'aspect_ratio', 'strength', 'num_images'],
  // For image-to-video, aspect_ratio / resolution get a smart default
  // auto-detected from the selected source image (see spec).
  video: ['prompt', 'image_url', 'duration', 'resolution', 'aspect_ratio'],
  audio: ['text', 'voice', 'speed'],
  music: ['prompt', 'duration'],
  // SAM-style segmentation: a text concept ("jacket") + the source image. The
  // exact text field name varies by model, so list the likely ones.
  segment: ['prompt', 'text_prompt', 'image_url'],
  // Image-to-3D: image-primary (the source image is hidden, like edit models),
  // so the surfaced knob is whether to also generate textures.
  model3d: ['input_image_url', 'image_url', 'textured_mesh'],
  // Image-to-panorama: image-primary (source hidden) + a required scene prompt.
  panorama: ['prompt', 'image_url'],
  // Rigging, sound + merge use dedicated selection-driven screens, not the form.
  rig: [],
  // Text-to-motion has its own screen (prompt + duration), not the form.
  motion: [],
  sound: ['prompt'],
  merge: [],
  // Long-tail (all screen: 'generic') — names absent from a given model's
  // schema are simply skipped, so these are best-effort guesses at the
  // typical primary field, not a hard requirement.
  llm: ['prompt', 'system_prompt'],
  vision: ['prompt', 'image_url'],
  data: ['prompt', 'image_url'],
  training: ['images_data_url'],
  workflow: ['prompt'],
  other: ['prompt'],
};
