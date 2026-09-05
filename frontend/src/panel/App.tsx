import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { HomeScreen, type BrowseMode, type CaptureTool } from './screens/HomeScreen';
import { ImageGenScreen } from './screens/ImageGenScreen';
import { FirstLastVideoScreen } from './screens/FirstLastVideoScreen';
import { ReferenceToVideoScreen } from './screens/ReferenceToVideoScreen';
import { GenericModelScreen } from './screens/GenericModelScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { MergeVideosScreen } from './screens/MergeVideosScreen';
import { MergeAudioVideoScreen } from './screens/MergeAudioVideoScreen';
import { RiggingScreen } from './screens/RiggingScreen';
import { SoundScreen } from './screens/SoundScreen';
import { SketchToTryOnScreen } from '../apps/sketch-to-tryon/Screen';
import { MaskCreatorScreen } from '../apps/mask-creator/Screen';
import { NanoBananaPatternScreen } from '../apps/nano-banana-pattern/Screen';
import { PatternFillScreen } from '../apps/pattern-fill/Screen';
import { AddVideoFromUrlScreen } from '../apps/add-video-from-url/Screen';
import { ActiveJobsTray } from './ActiveJobsTray';
import { CreditsBadge } from './CreditsBadge';
import {
  applyFavourites,
  cacheSyncedModels,
  familyByKey,
  findModel,
  isReferenceToVideo,
  markCatalogReady,
  mergeSyncedCatalog,
  setActiveCatalogFilter,
  setActiveModels,
  taskOf,
  type FalModel,
  type ModelFamily,
} from '../shared/falCatalog';
import { useCatalogReady } from './hooks/useCatalog';
import { getCatalogFilter, getFavourites } from '../shared/storage';
import { getConnectedResources, getParentFrameId } from '../shared/boardHelpers';
import { buildRecipeSeed, type RecipeCard, type RecipeSeed } from '../shared/recipeCard';
import { loadBackendConfig } from '../shared/backendConfig';
import { api } from '../lib/api';
import '../styles/index.css';

/** Two-frame video models (first/start + last/end) get a dedicated screen. */
function isFirstLast(model: FalModel): boolean {
  return Boolean(model.twoFrame);
}

/**
 * Open a "→ Image" capture utility in the modal iframe (fullscreen, so the user
 * gets a large, high-resolution view to capture from). The target board item's
 * id travels in the URL.
 */
function openCaptureModal(tool: CaptureTool, itemId: string): void {
  void miro.board.ui.openModal({
    url: `modal.html?tool=${encodeURIComponent(tool)}&itemId=${encodeURIComponent(itemId)}`,
    fullscreen: true,
  });
}

/** Open the Scene Builder (inputs are stashed in board appData beforehand). */
function openSceneModal(): void {
  void miro.board.ui.openModal({ url: 'modal.html?tool=scene-builder', fullscreen: true });
}

/** The schema-driven ImageGenScreen handles every image-primary capability. */
function usesSchemaScreen(model: FalModel): boolean {
  return (
    model.capability === 'image' ||
    model.capability === 'video' ||
    model.capability === 'segment' ||
    model.capability === 'model3d' ||
    model.capability === 'panorama'
  );
}

/**
 * Pick the screen for the selected model (mutually exclusive). `seed` is only
 * meaningful for the two schema-driven screens — a settings card can only have
 * been saved from one of those, so reopening always routes back to one of them.
 */
function ModelScreen({ model, seed }: { model: FalModel; seed?: RecipeSeed | null }) {
  if (model.screen === 'generic') return <GenericModelScreen model={model} seed={seed} />;
  if (isReferenceToVideo(model)) return <ReferenceToVideoScreen model={model} seed={seed} />;
  if (isFirstLast(model)) return <FirstLastVideoScreen model={model} />;
  if (model.capability === 'rig') return <RiggingScreen model={model} />;
  if (model.capability === 'sound') return <SoundScreen model={model} />;
  if (model.capability === 'merge') {
    return model.endpointId.includes('merge-audio-video') ? (
      <MergeAudioVideoScreen model={model} />
    ) : (
      <MergeVideosScreen model={model} />
    );
  }
  if (usesSchemaScreen(model)) return <ImageGenScreen model={model} seed={seed} />;
  // Any other capability (audio, music, or a future/auto-synced model) runs
  // through the generic schema-driven screen.
  return <GenericModelScreen model={model} seed={seed} />;
}

/**
 * A model "family" page: the Nano-Banana-style task dropdown on top, with the
 * selected task's screen rendered below. Single-task families never reach here
 * (App jumps straight to the task).
 */
function FamilyScreen({ family, seed }: { family: ModelFamily; seed?: RecipeSeed | null }) {
  const [idx, setIdx] = useState(0);
  const task = family.tasks[idx] ?? family.tasks[0];

  return (
    <div className="family-screen">
      {family.tasks.length > 1 && (
        <label className="field task-select">
          <span>{family.name} · task</span>
          <select value={idx} onChange={(e) => setIdx(Number(e.target.value))}>
            {family.tasks.map((t, i) => (
              <option key={`${t.endpointId}·${t.task ?? i}`} value={i}>
                {taskOf(t)}
              </option>
            ))}
          </select>
        </label>
      )}
      <ModelScreen model={task} seed={seed} />
    </div>
  );
}

/**
 * Shown between "backend configured" and "catalog settled". The catalog is
 * synced from fal at runtime with no built-in list behind it, so without this
 * a first-ever load would show an empty Browse grid that reads as broken
 * rather than as a catalog still arriving.
 */
function CatalogLoadingScreen() {
  return (
    <div className="catalog-loading">
      <span className="spinner" aria-hidden="true" />
      <span>Loading models…</span>
    </div>
  );
}

function App() {
  const [family, setFamily] = useState<ModelFamily | null>(null);
  const [model, setModel] = useState<FalModel | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [recipeSeed, setRecipeSeed] = useState<RecipeSeed | null>(null);
  const [openApp, setOpenApp] = useState<string | null>(null);
  // Which Browse tab HomeScreen shows. Owned here rather than in HomeScreen
  // because opening an app (or a model) unmounts HomeScreen entirely — local
  // state there would drop the user back on Category every time they hit Back.
  const [browseMode, setBrowseMode] = useState<BrowseMode>('category');
  // Reading localStorage is synchronous, so this is known on first render —
  // false forces the settings screen (nothing else can run without a
  // backend); no public default, so an unconfigured install fails closed
  // instead of silently spending whoever's Fal credits happened to be baked
  // into a shared build.
  const [backendReady, setBackendReady] = useState<boolean>(() => loadBackendConfig());
  const catalogReady = useCatalogReady();

  // Load the persisted curation filter, then sync the full model catalog from
  // fal metadata. Both push into the live catalog.
  useEffect(() => {
    if (!backendReady) return;
    getCatalogFilter()
      .then(setActiveCatalogFilter)
      .catch((e) => console.warn('[App] loading catalog filter failed', e));
    api
      .getModels()
      .then((res) => {
        setActiveModels(mergeSyncedCatalog(res.models));
        // Cache for next load — see falCatalog.ts's readCachedSyncedModels.
        cacheSyncedModels(res.models);
      })
      .catch((e) => console.warn('[App] catalog sync failed', e))
      // Either way, the catalog has settled — stop showing the loading screen.
      // A failed sync leaves whatever the cache had (nothing, on a first-ever
      // load), which still beats a loading state stuck forever.
      .finally(markCatalogReady);
    getFavourites()
      .then(applyFavourites)
      .catch((e) => console.warn('[App] loading favourites failed', e));
  }, [backendReady]);

  // Browse selects a family; single-task families jump straight to the task.
  const selectFamily = (key: string) => {
    const fam = familyByKey(key);
    if (!fam) return;
    if (fam.tasks.length === 1) {
      setModel(fam.tasks[0]);
      setFamily(null);
    } else {
      setFamily(fam);
      setModel(null);
    }
  };

  const goBack = () => {
    setModel(null);
    setFamily(null);
    setShowSettings(false);
    setRecipeSeed(null);
    setOpenApp(null);
  };

  // Explicit reopen trigger (the "For your selection" ToolCard on a settings
  // card) — resolve what's currently connected to the card, build a seed from
  // it + the card's saved static input, and jump to the model's real screen.
  // Falls back to a minimal synthetic model if the catalog can't resolve the
  // endpoint (e.g. a long-tail synced model not yet loaded this session).
  const openRecipe = async (recipe: RecipeCard, cardId: string) => {
    const target =
      findModel(recipe.endpointId) ??
      ({
        endpointId: recipe.endpointId,
        label: recipe.endpointId.replace(/^fal-ai\//, ''),
        capability: recipe.capability,
      } as FalModel);
    const [connected, frameId] = await Promise.all([getConnectedResources(cardId), getParentFrameId(cardId)]);
    setRecipeSeed(buildRecipeSeed(recipe, cardId, connected, frameId));
    setFamily(null);
    setModel(target);
  };

  // No backend configured in this browser yet — the only thing this iframe
  // can do is let the user set one. No back button: there's nowhere to go.
  if (!backendReady) {
    return (
      <div className="app">
        <div className="topbar">
          <span className="brand">fal</span>
          <span className="brand-sub">for Miro</span>
        </div>
        <div className="content">
          <SettingsScreen forceBackendSetup onBackendConfigured={() => setBackendReady(true)} />
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <div className="topbar">
        {(model || family || showSettings || openApp) && (
          <button type="button" className="back-link" onClick={goBack} aria-label="Back">
            ← Back
          </button>
        )}
        <span className="brand">fal</span>
        <span className="brand-sub">for Miro</span>
        <CreditsBadge onOpenSettings={() => setShowSettings(true)} />
      </div>

      <div className="content">
        <ActiveJobsTray />

        {showSettings ? (
          <SettingsScreen onBackendConfigured={() => setBackendReady(true)} />
        ) : !catalogReady ? (
          <CatalogLoadingScreen />
        ) : openApp === 'sketch-to-tryon' ? (
          <SketchToTryOnScreen />
        ) : openApp === 'mask-creator' ? (
          <MaskCreatorScreen />
        ) : openApp === 'nano-banana-pattern' ? (
          <NanoBananaPatternScreen />
        ) : openApp === 'pattern-fill' ? (
          <PatternFillScreen />
        ) : openApp === 'add-video-from-url' ? (
          <AddVideoFromUrlScreen />
        ) : model ? (
          <ModelScreen model={model} seed={recipeSeed} />
        ) : family ? (
          <FamilyScreen key={family.key} family={family} seed={recipeSeed} />
        ) : (
          <HomeScreen
            browseMode={browseMode}
            onBrowseModeChange={setBrowseMode}
            onOpenApp={setOpenApp}
            onSelectFamily={selectFamily}
            onSelectModel={setModel}
            onOpenTool={openCaptureModal}
            onOpenScene={openSceneModal}
            onOpenSettings={() => setShowSettings(true)}
            onOpenRecipe={(recipe, cardId) => void openRecipe(recipe, cardId)}
          />
        )}
      </div>
    </div>
  );
}

const container = document.getElementById('root');
if (container) createRoot(container).render(<App />);
else console.error('Panel: #root not found');
