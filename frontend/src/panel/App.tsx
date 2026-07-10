import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { HomeScreen, type CaptureTool } from './screens/HomeScreen';
import { ImageGenScreen } from './screens/ImageGenScreen';
import { FirstLastVideoScreen } from './screens/FirstLastVideoScreen';
import { ReferenceToVideoScreen } from './screens/ReferenceToVideoScreen';
import { GenericModelScreen } from './screens/GenericModelScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { MergeVideosScreen } from './screens/MergeVideosScreen';
import { MergeAudioVideoScreen } from './screens/MergeAudioVideoScreen';
import { RiggingScreen } from './screens/RiggingScreen';
import { SoundScreen } from './screens/SoundScreen';
import { ActiveJobsTray } from './ActiveJobsTray';
import { CreditsBadge } from './CreditsBadge';
import {
  applyFavourites,
  familyByKey,
  isReferenceToVideo,
  mergeSyncedCatalog,
  setActiveCatalogFilter,
  setActiveModels,
  taskOf,
  type FalModel,
  type ModelFamily,
} from '../shared/falCatalog';
import { getCatalogFilter, getFavourites } from '../shared/storage';
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

/** Pick the screen for the selected model (mutually exclusive). */
function ModelScreen({ model }: { model: FalModel }) {
  if (model.screen === 'generic') return <GenericModelScreen model={model} />;
  if (isReferenceToVideo(model)) return <ReferenceToVideoScreen model={model} />;
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
  if (usesSchemaScreen(model)) return <ImageGenScreen model={model} />;
  // Any other capability (audio, music, or a future/auto-synced model) runs
  // through the generic schema-driven screen.
  return <GenericModelScreen model={model} />;
}

/**
 * A model "family" page: the Nano-Banana-style task dropdown on top, with the
 * selected task's screen rendered below. Single-task families never reach here
 * (App jumps straight to the task).
 */
function FamilyScreen({ family }: { family: ModelFamily }) {
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
      <ModelScreen model={task} />
    </div>
  );
}

function App() {
  const [family, setFamily] = useState<ModelFamily | null>(null);
  const [model, setModel] = useState<FalModel | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  // Load the persisted curation filter, then sync the full model catalog from
  // fal metadata (merged over the hand list). Both push into the live catalog.
  useEffect(() => {
    getCatalogFilter()
      .then(setActiveCatalogFilter)
      .catch((e) => console.warn('[App] loading catalog filter failed', e));
    api
      .getModels()
      .then((res) => setActiveModels(mergeSyncedCatalog(res.models)))
      .catch((e) => console.warn('[App] catalog sync failed — using built-in list', e));
    getFavourites()
      .then(applyFavourites)
      .catch((e) => console.warn('[App] loading favourites failed', e));
  }, []);

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
  };

  return (
    <div className="app">
      <div className="topbar">
        {(model || family || showSettings) && (
          <button type="button" className="back-link" onClick={goBack} aria-label="Back">
            ← Back
          </button>
        )}
        <span className="brand">fal</span>
        <span className="brand-sub">for Miro</span>
        <CreditsBadge />
      </div>

      <div className="content">
        <ActiveJobsTray />

        {showSettings ? (
          <SettingsScreen />
        ) : model ? (
          <ModelScreen model={model} />
        ) : family ? (
          <FamilyScreen key={family.key} family={family} />
        ) : (
          <HomeScreen
            onSelectFamily={selectFamily}
            onSelectModel={setModel}
            onOpenTool={openCaptureModal}
            onOpenScene={openSceneModal}
            onOpenSettings={() => setShowSettings(true)}
          />
        )}
      </div>
    </div>
  );
}

const container = document.getElementById('root');
if (container) createRoot(container).render(<App />);
else console.error('Panel: #root not found');
