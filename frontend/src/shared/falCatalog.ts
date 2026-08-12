// Central catalog of Fal model endpoints, grouped by capability.
//
// In Option A (the chosen approach) this file stays small: it lists which
// endpoints the app exposes and which capability each belongs to. The actual
// input controls are generated at runtime from each model's live OpenAPI
// schema (fetched via the backend /api/fal/schema route), split into the
// "always-shown" common tier below and a generic "Advanced" section.
//
// NAVIGATION (redesign): each entry also declares the `family` it belongs to
// (the "model", e.g. "Veo 3.1") and its `task` within that family (e.g. "Image
// to Video", "Edit"). Browse is Provider ▸ Model(family) ▸ Task, plus a
// Category axis (fal-style input→output categories). These fields are set here
// today; the plan is to source family/category/tags from fal's per-endpoint
// metadata (already returned by /api/fal/schema) so the list self-maintains.

export type Capability =
  | 'image'
  | 'video'
  | 'audio'
  | 'music'
  | 'segment'
  | 'model3d'
  | 'panorama'
  | 'rig'
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
  /** Hidden from the home screen unless SHOW_EXPERIMENTAL is on. */
  experimental?: boolean;
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
  /** Explicit category label (synced models carry fal's; hand models derive it). */
  category?: string;
  /** Force the generic schema screen (synced long-tail: audio, LLM, training…). */
  screen?: 'generic';
  /** Marks an auto-synced entry (from fal metadata) vs a hand-curated one. */
  synced?: boolean;
  /** Model thumbnail from fal metadata, if any. */
  thumbnailUrl?: string;
};

// Flip to true to surface the experimental models (Flux family, Seedance, TTS,
// Veo first-last-frame) in the home screen. Off for the golden demo, which is
// focused on Nano Banana (image) + Veo 3.1 (video).
export const SHOW_EXPERIMENTAL = false;

export const FAL_MODELS: FalModel[] = [
  // ── Golden-demo models (enabled) ───────────────────────────────────────
  { endpointId: 'fal-ai/nano-banana/edit', label: 'Nano Banana (edit)', capability: 'image', family: 'Nano Banana', task: 'Edit' },
  { endpointId: 'fal-ai/gemini-3-pro-image-preview/edit', label: 'Nano Banana Pro (edit)', capability: 'image', family: 'Nano Banana', task: 'Edit · Pro' },
  // Text-to-image generators (image optional → selected/connected stickies fill the prompt).
  { endpointId: 'fal-ai/nano-banana', label: 'Nano Banana · Generate (text→image)', capability: 'image', generate: true, family: 'Nano Banana', task: 'Generate' },
  { endpointId: 'fal-ai/nano-banana-pro', label: 'Nano Banana Pro · Generate (text→image)', capability: 'image', generate: true, family: 'Nano Banana', task: 'Generate · Pro' },
  { endpointId: 'fal-ai/flux-2-pro', label: 'FLUX.2 [pro] · Generate', capability: 'image', generate: true, family: 'FLUX.2', task: 'Generate · Pro' },
  { endpointId: 'fal-ai/flux-2', label: 'FLUX.2 [dev] · Generate (cheaper)', capability: 'image', generate: true, family: 'FLUX.2', task: 'Generate · Dev' },
  // Seedream (ByteDance) — the source-image generator for the Seedance video
  // pipeline. Seedance's moderation flags realistic AI images from OTHER
  // providers (Flux / Nano Banana / Veo frames) as real-person likenesses and
  // rejects them; frames made by ByteDance's own image model pass, so generate
  // people/source frames here when they're bound for Seedance. Both a text→image
  // generator and a multi-image edit endpoint; 4.5 is latest, 4.0 kept as backup.
  { endpointId: 'fal-ai/bytedance/seedream/v4.5/text-to-image', label: 'Seedream 4.5 · Generate (text→image)', capability: 'image', generate: true, family: 'Seedream 4.5', task: 'Generate' },
  { endpointId: 'fal-ai/bytedance/seedream/v4.5/edit', label: 'Seedream 4.5 (edit)', capability: 'image', family: 'Seedream 4.5', task: 'Edit' },
  { endpointId: 'fal-ai/bytedance/seedream/v4/text-to-image', label: 'Seedream 4.0 · Generate (text→image)', capability: 'image', generate: true, family: 'Seedream 4.0', task: 'Generate' },
  { endpointId: 'fal-ai/bytedance/seedream/v4/edit', label: 'Seedream 4.0 (edit)', capability: 'image', family: 'Seedream 4.0', task: 'Edit' },
  { endpointId: 'fal-ai/veo3.1/image-to-video', label: 'Veo 3.1 · Image to Video', capability: 'video', family: 'Veo 3.1', task: 'Image to Video' },
  { endpointId: 'fal-ai/veo3.1/fast/image-to-video', label: 'Veo 3.1 Fast · Image to Video', capability: 'video', family: 'Veo 3.1', task: 'Image to Video · Fast' },
  { endpointId: 'fal-ai/sam-3/image', label: 'SAM 3 · Extract object', capability: 'segment', family: 'SAM 3', task: 'Extract object' },
  // Image to 3D — drops an orbit-able .glb viewer embed on the board. Hunyuan3D
  // v2 is the balanced default ($0.16, glb); TripoSR is the fast/cheap option
  // (~0.5s, $0.07); Hunyuan3D v3 is the high-quality (PBR) one.
  { endpointId: 'fal-ai/hunyuan3d/v2', label: 'Hunyuan3D v2 · Image to 3D', capability: 'model3d', family: 'Hunyuan3D v2', task: 'Image to 3D' },
  { endpointId: 'fal-ai/triposr', label: 'TripoSR · Image to 3D (fast)', capability: 'model3d', family: 'TripoSR', task: 'Image to 3D' },
  { endpointId: 'fal-ai/hunyuan3d-v3/image-to-3d', label: 'Hunyuan3D v3 · Image to 3D (quality)', capability: 'model3d', family: 'Hunyuan3D v3', task: 'Image to 3D' },
  // Image to 3D panorama — Hunyuan World turns an image + prompt into an
  // equirectangular 360° environment; drops an interactive photosphere embed.
  { endpointId: 'fal-ai/hunyuan_world', label: 'Hunyuan World · Image to Panorama', capability: 'panorama', family: 'Hunyuan World', task: 'Image to Panorama' },
  // 3D → rigged + animated character. Source is a 3D model already on the board;
  // output is an animated viewer you can pose via the "Rig Viewer → Image" tool.
  { endpointId: 'fal-ai/meshy/rigging/multi-animation', label: 'Meshy · Rig + Animate (character)', capability: 'rig', family: 'Meshy Rig', task: 'Rig + Animate' },
  // Video → sound: generate a soundtrack/foley for a board video; output is the
  // same video with audio muxed in.
  { endpointId: 'fal-ai/thinksound', label: 'ThinkSound · Video to Sound (auto)', capability: 'sound', family: 'ThinkSound', task: 'Video to Sound' },
  { endpointId: 'fal-ai/mmaudio-v2', label: 'MMAudio v2 · Video to Sound', capability: 'sound', family: 'MMAudio', task: 'Video to Sound' },
  { endpointId: 'fal-ai/hunyuan-video-foley', label: 'Hunyuan Foley · Video to Sound', capability: 'sound', family: 'Hunyuan Foley', task: 'Video to Sound' },
  // Merge ops — Fal's FFmpeg endpoints. Operate on videos already on the board.
  { endpointId: 'fal-ai/ffmpeg-api/merge-videos', label: 'Merge Videos (concatenate)', capability: 'merge', family: 'FFmpeg utilities', task: 'Merge Videos' },
  { endpointId: 'fal-ai/ffmpeg-api/merge-audio-video', label: 'Merge Audio + Video', capability: 'merge', family: 'FFmpeg utilities', task: 'Merge Audio + Video' },
  // Veo 3.1 — best quality + native audio, but Gemini blocks identifiable PEOPLE.
  { endpointId: 'fal-ai/veo3.1/first-last-frame-to-video', label: 'Veo 3.1 · First+Last Frame', capability: 'video', twoFrame: true, family: 'Veo 3.1', task: 'First + Last' },
  // Seedance — for the human scenes Veo refuses.
  // 1.5 Pro is the people-friendly one (works in practice). 2.0 is newer but, like
  // Veo, blocks real-people likenesses — keep it for non-people shots.
  { endpointId: 'fal-ai/bytedance/seedance/v1.5/pro/image-to-video', label: 'Seedance 1.5 Pro · Image to Video (people)', capability: 'video', family: 'Seedance 1.5 Pro', task: 'Image to Video' },
  { endpointId: 'fal-ai/bytedance/seedance/v1.5/pro/image-to-video', label: 'Seedance 1.5 Pro · Start+End (people)', capability: 'video', twoFrame: true, family: 'Seedance 1.5 Pro', task: 'Start + End' },
  { endpointId: 'bytedance/seedance-2.0/image-to-video', label: 'Seedance 2.0 · Image to Video', capability: 'video', family: 'Seedance 2.0', task: 'Image to Video' },
  { endpointId: 'bytedance/seedance-2.0/image-to-video', label: 'Seedance 2.0 · Start+End', capability: 'video', twoFrame: true, family: 'Seedance 2.0', task: 'Start + End' },
  // Reference-to-video — weave several named board references (images + video
  // clips) into one shot; the prompt is adapted to @Image1 / @Video1 tokens.
  // The consistency workhorse for character/prop/style continuity.
  { endpointId: 'bytedance/seedance-2.0/reference-to-video', label: 'Seedance 2.0 · References to Video', capability: 'video', family: 'Seedance 2.0', task: 'References to Video' },
  { endpointId: 'bytedance/seedance-2.0/fast/reference-to-video', label: 'Seedance 2.0 Fast · References to Video', capability: 'video', family: 'Seedance 2.0', task: 'References to Video · Fast' },
  // Veo 3.1 reference-to-video — blends reference images ("ingredients"), images only.
  { endpointId: 'fal-ai/veo3.1/reference-to-video', label: 'Veo 3.1 · References to Video', capability: 'video', family: 'Veo 3.1', task: 'References to Video' },
  { endpointId: 'fal-ai/veo3.1/fast/reference-to-video', label: 'Veo 3.1 Fast · References to Video', capability: 'video', family: 'Veo 3.1', task: 'References to Video · Fast' },

  // ── Behind the flag (kept, not deleted) ────────────────────────────────
  { endpointId: 'fal-ai/flux/dev', label: 'Flux.1 [dev] (text→image)', capability: 'image', experimental: true, generate: true, family: 'FLUX.1', task: 'Generate (dev)' },
  { endpointId: 'fal-ai/flux-1/dev/image-to-image', label: 'Flux.1 [dev] image-to-image', capability: 'image', experimental: true, family: 'FLUX.1', task: 'Image to Image' },
  { endpointId: 'fal-ai/flux-general', label: 'Flux General (ControlNet / IP-Adapter)', capability: 'image', experimental: true, generate: true, family: 'FLUX.1', task: 'ControlNet / IP-Adapter' },
  { endpointId: 'fal-ai/gemini-tts', label: 'Gemini TTS', capability: 'audio', experimental: true, family: 'Gemini TTS', task: 'Text to Speech' },
  { endpointId: 'fal-ai/evf-sam', label: 'EVF-SAM · Text cutout', capability: 'segment', experimental: true, family: 'EVF-SAM', task: 'Text cutout' },
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
  'Video to Audio',
  'Video editing',
];
export const DEFAULT_CATALOG_FILTER: CatalogFilter = { providers: null, categories: DEFAULT_MEDIA_CATEGORIES };

let activeFilter: CatalogFilter = DEFAULT_CATALOG_FILTER;
const catalogListeners = new Set<() => void>();

// Cache of the last successful catalog sync (see mergeSyncedCatalog below) —
// read synchronously at module init so a *returning* user sees the full
// catalog immediately instead of just the ~40-entry hand list while
// api.getModels() re-fetches in the background (App.tsx). Only the first-ever
// load per browser (no cache yet) falls back to the hand list. No staleness
// check: even a week-old cache is a fine instant placeholder, since the
// background refresh always overwrites it within seconds anyway.
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

// The live model set. Defaults to the hand list; a cached sync from a
// previous session (if any) is merged in further down this file, once
// mergeSyncedCatalog and what it depends on are actually defined — calling
// it up here, before those `const`s below have run, would throw (temporal
// dead zone). Replaced again once a fresh sync completes. Browse helpers
// read this.
let activeModels: FalModel[] = FAL_MODELS;
export function setActiveModels(models: FalModel[]): void {
  activeModels = models;
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

/** Models shown in the UI — hides experimental ones + applies the curation filter. */
export function enabledModels(): FalModel[] {
  let list = SHOW_EXPERIMENTAL ? activeModels : activeModels.filter((m) => !m.experimental);
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
  const base = SHOW_EXPERIMENTAL ? activeModels : activeModels.filter((m) => !m.experimental);
  for (const m of base) set.add(providerOf(m.endpointId));
  return [...set].sort();
}
export function allCategories(): string[] {
  const base = SHOW_EXPERIMENTAL ? activeModels : activeModels.filter((m) => !m.experimental);
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
  // Search the live (hand + synced) catalog, not just the hand list — a
  // settings card can reference a long-tail synced model.
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
  const base = SHOW_EXPERIMENTAL ? activeModels : activeModels.filter((m) => !m.experimental);
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
// Synced catalog — merge fal's Models metadata over the hand list. Hand entries
// win (they carry routing flags: generate / twoFrame / reference / family /
// task). New models map their fal category → our capability + screen; the long
// tail (audio, LLM, training…) routes to the generic screen.
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

/** Merge fal metadata over the hand catalog → the full model list. */
export function mergeSyncedCatalog(meta: SyncedMeta[]): FalModel[] {
  const out: FalModel[] = [...FAL_MODELS];
  const seen = new Set(FAL_MODELS.map((m) => m.endpointId));
  for (const m of meta) {
    if (!m.endpointId || seen.has(m.endpointId)) continue;
    if (m.status && m.status !== 'active') continue;
    seen.add(m.endpointId);
    const mapped = mapFalCategory((m.category ?? '').toLowerCase());
    out.push({
      endpointId: m.endpointId,
      label: m.displayName?.trim() || m.endpointId,
      capability: mapped.capability,
      category: mapped.label,
      family: m.displayName?.trim() || m.endpointId,
      task: mapped.label,
      synced: true,
      ...(mapped.generate ? { generate: true } : {}),
      ...(mapped.screen ? { screen: mapped.screen } : {}),
      ...(m.thumbnailUrl ? { thumbnailUrl: m.thumbnailUrl } : {}),
    });
  }
  return out;
}

// Apply a cached sync from a previous session now that mergeSyncedCatalog
// (and FAL_CATEGORY_MAP/mapFalCategory, which it depends on) are actually
// defined — see the `activeModels` comment near the top of this file for why
// this can't happen any earlier. No-op (stays on the hand list) on the
// first-ever load, when there's nothing cached yet.
{
  const cachedSyncedModels = readCachedSyncedModels();
  if (cachedSyncedModels) setActiveModels(mergeSyncedCatalog(cachedSyncedModels));
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
