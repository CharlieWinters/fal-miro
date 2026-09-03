// Helpers around miro.board.setAppData / getAppData for the active-jobs ledger,
// plus item-level metadata for per-asset regenerate settings.
//
// 30 KB cap on app data, 6 KB per item for metadata — keep payloads small.

import { DEFAULT_ASSET_NAMING, type AssetNamingConfig } from './assetNaming';
import { DEFAULT_CATALOG_FILTER, type CatalogFilter } from './falCatalog';

export type JobKind = 'image' | 'video' | 'audio' | 'model3d' | 'panorama' | 'rig' | 'generic';

export type GenSettings = {
  endpointId: string;
  /** The exact model input we sent (so a future Regenerate can re-run it). */
  input: Record<string, unknown>;
  /** Ratio used for the placeholder, e.g. "1:1". */
  ratio: string;
  /** Sticky that drove the prompt, if any. */
  sourceStickyId?: string;
  /** Asset id detected from the prompt — used to name the generated image. */
  assetName?: string;
  /** Estimated cost of this generation in USD (best-effort). */
  costUSD?: number;
  /** Miro item ids this asset was generated from — used to trace lineage. */
  parents?: string[];
  /** For rigged characters: the animation clips (name → glb url) so the pose
   *  tool can switch between them. Each is a standalone animated glb. */
  animations?: Array<{ name: string; url: string }>;
  /** For rigged characters: the rest-pose rig glb — the manual (FK) poser loads
   *  this so it starts from a neutral pose rather than a walk frame. */
  restPoseUrl?: string;
};

export type ActiveJob = {
  /** Fal queue request id. */
  requestId: string;
  /** Fal endpoint id — required to poll status/result. */
  endpointId: string;
  /** Miro item id of the placeholder image. */
  placeholderId: string;
  /** Board coords we intended for the placeholder; re-asserted on completion. */
  targetPosition?: { x: number; y: number };
  kind: JobKind;
  createdAt: number;
  settings: GenSettings;
  /** Set when this job is one step of a pipeline app run (see pipelineRunner.ts)
   *  — resume_jobs uses these to hand off to advancePipelineForJob instead of
   *  its normal single-model finalize. */
  pipelineRunId?: string;
  stepIndex?: number;
};

// ---------------------------------------------------------------------------
// Pipeline runs — multi-model "app" pipelines (see shared/pipelineApps.ts +
// shared/pipelineRunner.ts). Persisted the same way as active jobs (board
// appData, so a run survives a closed/reopened board and is visible to every
// collaborator on the board, not just the person who started it).
// ---------------------------------------------------------------------------
export type PipelineStepStatus = 'pending' | 'running' | 'done' | 'failed';

export type PipelineStepState = {
  endpointId: string;
  status: PipelineStepStatus;
  requestId?: string;
  outputUrl?: string;
  /** The board item holding this step's result — only set when the app lays
   *  results out on the board (see PipelineRun.boardLayout). */
  outputItemId?: string;
};

export type PipelineRun = {
  id: string;
  /** Key into PIPELINE_APPS (shared/pipelineApps.ts). */
  appId: string;
  /** Per-app choice: does this app place its steps' outputs on the board, or
   *  keep everything inside its own panel screen? */
  boardLayout: boolean;
  /** The run's fixed (non-chained) inputs — e.g. the images a user picked. */
  fixedInputs: Record<string, unknown>;
  steps: PipelineStepState[];
  currentStep: number;
  createdAt: number;
};

const ACTIVE_JOBS_KEY = 'fal:activeJobs';
const PIPELINE_RUNS_KEY = 'fal:pipelineRuns';
const ITEM_META_NS = 'fal';

// Short-lived cache over board appData. The burst of config reads on open (jobs,
// curation filter, favourites, asset-naming) collapses to a single metered
// getAppData, and rapid re-reads reuse it. Busted whenever we write.
let appDataCache: { at: number; p: Promise<Record<string, unknown>> } | null = null;
const APPDATA_TTL_MS = 1500;

async function readAppData(): Promise<Record<string, unknown>> {
  if (appDataCache && Date.now() - appDataCache.at < APPDATA_TTL_MS) return appDataCache.p;
  const p = (miro.board.getAppData() as Promise<Record<string, unknown>>).catch((e) => {
    appDataCache = null; // don't cache a failed read
    throw e;
  });
  appDataCache = { at: Date.now(), p };
  return p;
}

async function writeAppData(key: string, value: Parameters<typeof miro.board.setAppData>[1]): Promise<void> {
  await miro.board.setAppData(key, value);
  appDataCache = null; // keep the cache honest after a write
}

export async function getActiveJobs(): Promise<ActiveJob[]> {
  try {
    const all = await readAppData();
    const jobs = all?.[ACTIVE_JOBS_KEY];
    return Array.isArray(jobs) ? (jobs as ActiveJob[]) : [];
  } catch (e) {
    console.warn('[storage] getActiveJobs failed:', e);
    return [];
  }
}

/** Drop `undefined` values — Miro's setAppData / setMetadata reject them. */
function stripUndefined<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

// appData has a ~30 KB cap and item metadata ~6 KB, so we must never persist
// heavy values. Reference images arrive as base64 data URIs (often MBs) in
// `input` — replace those (and any oversized string) with a light marker. We
// keep only what resume / a future Regenerate actually needs; the images can be
// re-resolved from the board.
const MAX_PERSISTED_STR = 512;

function slimValue(v: unknown): unknown {
  if (typeof v === 'string') {
    if (v.startsWith('data:')) return '[image]';
    return v.length > MAX_PERSISTED_STR ? `${v.slice(0, MAX_PERSISTED_STR)}…` : v;
  }
  if (Array.isArray(v)) return v.map(slimValue);
  return v;
}

function slimSettings(s: GenSettings): GenSettings {
  const input: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(s.input)) input[k] = slimValue(val);
  return { ...s, input };
}

export async function saveActiveJobs(jobs: ActiveJob[]): Promise<void> {
  // Trim to most recent 30, and slim each job's settings so big image data
  // never lands in appData.
  const slim = jobs.slice(-30).map((j) => ({ ...j, settings: slimSettings(j.settings) }));
  // stripUndefined JSON-round-trips the value, so it's a valid AppDataValue at
  // runtime; the cast just tells TS what the deep JSON shape satisfies (our
  // GenSettings.input is Record<string, unknown>, which it can't verify).
  const payload = stripUndefined(slim) as Parameters<typeof miro.board.setAppData>[1];
  await writeAppData(ACTIVE_JOBS_KEY, payload);
}

export async function addActiveJob(job: ActiveJob): Promise<void> {
  const jobs = await getActiveJobs();
  jobs.push(job);
  await saveActiveJobs(jobs);
}

export async function removeActiveJob(requestId: string): Promise<void> {
  const jobs = (await getActiveJobs()).filter((j) => j.requestId !== requestId);
  await saveActiveJobs(jobs);
}

export async function getPipelineRuns(): Promise<PipelineRun[]> {
  try {
    const all = await readAppData();
    const runs = all?.[PIPELINE_RUNS_KEY];
    return Array.isArray(runs) ? (runs as PipelineRun[]) : [];
  } catch (e) {
    console.warn('[storage] getPipelineRuns failed:', e);
    return [];
  }
}

export async function savePipelineRuns(runs: PipelineRun[]): Promise<void> {
  // Trim to the most recent 10, and slim fixedInputs the same way active-job
  // settings are slimmed (board images arrive as base64 data URIs). Step
  // outputUrls are never slimmed — they're ordinary hosted Fal URLs, and the
  // next step needs the real value, not a truncated marker.
  const slim = runs.slice(-10).map((r) => ({
    ...r,
    fixedInputs: Object.fromEntries(Object.entries(r.fixedInputs).map(([k, v]) => [k, slimValue(v)])),
  }));
  const payload = stripUndefined(slim) as Parameters<typeof miro.board.setAppData>[1];
  await writeAppData(PIPELINE_RUNS_KEY, payload);
}

export async function addPipelineRun(run: PipelineRun): Promise<void> {
  const runs = await getPipelineRuns();
  runs.push(run);
  await savePipelineRuns(runs);
}

export async function updatePipelineRun(id: string, patch: Partial<PipelineRun>): Promise<PipelineRun | undefined> {
  const runs = await getPipelineRuns();
  const idx = runs.findIndex((r) => r.id === id);
  if (idx === -1) return undefined;
  runs[idx] = { ...runs[idx], ...patch };
  await savePipelineRuns(runs);
  return runs[idx];
}

/** Find the pipeline run (if any) whose step is currently tracking `requestId`. */
export async function findPipelineRunByRequestId(
  requestId: string,
): Promise<{ run: PipelineRun; stepIndex: number } | undefined> {
  const runs = await getPipelineRuns();
  for (const run of runs) {
    const stepIndex = run.steps.findIndex((s) => s.requestId === requestId);
    if (stepIndex !== -1) return { run, stepIndex };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Scene Builder handoff — the panel stashes the selected assets here so the
// (separate) modal iframe can read them. Small payload: a few resolved URLs.
// ---------------------------------------------------------------------------
const SCENE_INPUTS_KEY = 'fal:sceneInputs';

export type SceneInputs = {
  /** glb assets to load into the scene (from 3D / rig embeds). */
  assets: Array<{ url: string; name?: string }>;
  /** Equirectangular panorama for background + lighting, if one was selected. */
  panorama?: string | null;
  /** A board item to anchor the captured image near (first selected). */
  anchorItemId?: string | null;
};

export async function setSceneInputs(inputs: SceneInputs): Promise<void> {
  await writeAppData(SCENE_INPUTS_KEY, stripUndefined(inputs) as Parameters<typeof miro.board.setAppData>[1]);
}

export async function getSceneInputs(): Promise<SceneInputs | null> {
  try {
    const all = await readAppData();
    const v = all?.[SCENE_INPUTS_KEY];
    return v && typeof v === 'object' ? (v as SceneInputs) : null;
  } catch (e) {
    console.warn('[storage] getSceneInputs failed:', e);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Saved character poses — the manual poser stores custom bone rotations here,
// keyed by the rig item id. Same rig on save + recall, so no retargeting.
// Poses are kept compact (only the bones that differ from rest), so they fit
// alongside the jobs ledger in appData.
// ---------------------------------------------------------------------------
const POSES_KEY = 'fal:poses';
const MAX_POSES_PER_RIG = 8;

/** name → per-bone local quaternion [x,y,z,w] (only rotated bones stored). */
export type SavedPose = { name: string; rot: Record<string, number[]> };

async function readAllPoses(): Promise<Record<string, SavedPose[]>> {
  try {
    const all = await readAppData();
    const v = all?.[POSES_KEY];
    return v && typeof v === 'object' ? (v as Record<string, SavedPose[]>) : {};
  } catch {
    return {};
  }
}

export async function getSavedPoses(itemId: string): Promise<SavedPose[]> {
  return (await readAllPoses())[itemId] ?? [];
}

export async function saveSavedPose(itemId: string, pose: SavedPose): Promise<SavedPose[]> {
  const all = await readAllPoses();
  const list = (all[itemId] ?? []).filter((p) => p.name !== pose.name);
  list.push(pose);
  const trimmed = list.slice(-MAX_POSES_PER_RIG);
  all[itemId] = trimmed;
  await writeAppData(POSES_KEY, stripUndefined(all) as Parameters<typeof miro.board.setAppData>[1]);
  return trimmed;
}

export async function deleteSavedPose(itemId: string, name: string): Promise<SavedPose[]> {
  const all = await readAllPoses();
  const list = (all[itemId] ?? []).filter((p) => p.name !== name);
  all[itemId] = list;
  await writeAppData(POSES_KEY, stripUndefined(all) as Parameters<typeof miro.board.setAppData>[1]);
  return list;
}

export async function setItemGenerationSettings(
  itemId: string,
  settings: GenSettings,
): Promise<void> {
  try {
    const item = await miro.board.getById(itemId);
    if (!item || !('setMetadata' in item)) return;
    await (item as unknown as { setMetadata: (k: string, v: unknown) => Promise<void> }).setMetadata(
      ITEM_META_NS,
      stripUndefined(slimSettings(settings)),
    );
  } catch (e) {
    console.warn('[storage] setItemGenerationSettings failed:', e);
  }
}

// ---------------------------------------------------------------------------
// Asset-naming config — the board-level regex used to pull an asset id out of a
// prompt so generated images are named after their asset (see assetNaming.ts).
// Small payload; lives alongside the jobs ledger in appData.
// ---------------------------------------------------------------------------
const ASSET_NAMING_KEY = 'fal:assetNaming';

export async function getAssetNamingConfig(): Promise<AssetNamingConfig> {
  try {
    const all = await readAppData();
    const v = all?.[ASSET_NAMING_KEY];
    if (v && typeof v === 'object') {
      return { ...DEFAULT_ASSET_NAMING, ...(v as Partial<AssetNamingConfig>) };
    }
  } catch (e) {
    console.warn('[storage] getAssetNamingConfig failed:', e);
  }
  return DEFAULT_ASSET_NAMING;
}

export async function setAssetNamingConfig(cfg: AssetNamingConfig): Promise<void> {
  await writeAppData(
    ASSET_NAMING_KEY,
    stripUndefined(cfg) as Parameters<typeof miro.board.setAppData>[1],
  );
}

// Backend connection (URL + shared secret / Fal key) deliberately does NOT
// live here — see shared/backendConfig.ts. Same reasoning as the two below:
// per-person (localStorage), not per-board.

// ---------------------------------------------------------------------------
// Catalog curation filter — which providers/categories Browse shows — and
// favourited model families. Both are personal browsing preferences, not
// board content: forcing one collaborator's filter/favourites onto everyone
// else viewing the same board was the wrong scope, so these live in this
// browser's localStorage (per-person), not board appData. Kept async (though
// localStorage access is synchronous) so every existing call site —
// `.then()`/`await` in App.tsx, SettingsScreen.tsx, favourites.ts — keeps
// working unchanged.
// ---------------------------------------------------------------------------
const CATALOG_FILTER_KEY = 'fal:catalogFilter';
const FAVOURITES_KEY = 'fal:favourites';

export async function getCatalogFilter(): Promise<CatalogFilter> {
  try {
    const raw = localStorage.getItem(CATALOG_FILTER_KEY);
    const v = raw ? JSON.parse(raw) : null;
    if (v && typeof v === 'object') return { ...DEFAULT_CATALOG_FILTER, ...(v as Partial<CatalogFilter>) };
  } catch (e) {
    console.warn('[storage] getCatalogFilter failed:', e);
  }
  return DEFAULT_CATALOG_FILTER;
}

export async function setCatalogFilter(filter: CatalogFilter): Promise<void> {
  localStorage.setItem(CATALOG_FILTER_KEY, JSON.stringify(stripUndefined(filter)));
}

export async function getFavourites(): Promise<string[]> {
  try {
    const raw = localStorage.getItem(FAVOURITES_KEY);
    const v = raw ? JSON.parse(raw) : null;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch (e) {
    console.warn('[storage] getFavourites failed:', e);
    return [];
  }
}

export async function setFavourites(keys: string[]): Promise<void> {
  localStorage.setItem(FAVOURITES_KEY, JSON.stringify(keys));
}

// ---------------------------------------------------------------------------
// Prompt source — where a model screen's Prompt box gets its text.
//
//   'off'        the box is the user's; the board never writes to it
//   'selection'  live-follows the selected sticky notes
//   'connected'  follows sticky notes wired by a connector to the source image
//
// Read synchronously (unlike the two above) because it decides what the very
// first render of a prompt field shows — an async read would let the box paint
// empty and then fill in, which is the flicker this whole control exists to
// remove. Defaults to 'off': autofill is now opt-in.
// ---------------------------------------------------------------------------
export type PromptSource = 'off' | 'selection' | 'connected';

const PROMPT_SOURCE_KEY = 'fal:promptSource';

export function loadPromptSource(): PromptSource {
  try {
    const raw = localStorage.getItem(PROMPT_SOURCE_KEY);
    if (raw === 'off' || raw === 'selection' || raw === 'connected') return raw;
  } catch (e) {
    console.warn('[storage] loadPromptSource failed:', e);
  }
  return 'off';
}

export function savePromptSource(mode: PromptSource): void {
  try {
    localStorage.setItem(PROMPT_SOURCE_KEY, mode);
  } catch (e) {
    console.warn('[storage] savePromptSource failed:', e);
  }
}

export async function getItemGenerationSettings<T = unknown>(itemId: string): Promise<T | null> {
  try {
    const item = await miro.board.getById(itemId);
    if (!item || !('getMetadata' in item)) return null;
    const v = await (item as unknown as { getMetadata: (k: string) => Promise<unknown> }).getMetadata(
      ITEM_META_NS,
    );
    return (v as T) ?? null;
  } catch (e) {
    console.warn('[storage] getItemGenerationSettings failed:', e);
    return null;
  }
}
