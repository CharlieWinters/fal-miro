import { useMemo, useState } from 'react';
import {
  capabilityForCategory,
  categoriesPresent,
  enabledModels,
  familiesByCategory,
  familiesByProvider,
  findModel,
  providerOf,
  providersPresent,
  type Capability,
  type FalModel,
  type ModelFamily,
} from '../../shared/falCatalog';
import { favouriteFamilies, isFavourite } from '../../shared/falCatalog';
import { toggleFavourite } from '../favourites';
import { SelectionTools } from '../SelectionTools';
import { ProviderLogo } from '../ProviderLogo';
import { useCatalogVersion } from '../hooks/useCatalog';
import { useFirstSelected, useSelectedItems } from '../hooks/useSelection';
import {
  connectionMode,
  unwrapModel3dEmbedUrl,
  unwrapVideoEmbedUrl,
  unwrapPanoramaEmbedUrl,
  unwrapRigEmbedUrl,
} from '../../lib/api';
import { setSceneInputs } from '../../shared/storage';
import { toneOf, toneFill, toneOutline } from '../../shared/capabilityTone';
import { CapabilityIcon } from '../CapabilityIcon';
import { parseRecipeCard, type RecipeCard } from '../../shared/recipeCard';

/** "→ Image" capture utilities that open in the modal for a large view. */
export type CaptureTool =
  | 'viewer3d-to-image'
  | 'video-to-image'
  | 'panorama-to-image'
  | 'rig-to-image'
  | 'pose-character';

const CAPABILITY_VERB: Record<Capability, string> = {
  image: 'Generate Image',
  video: 'Generate Video',
  audio: 'Generate Audio',
  music: 'Generate Music',
  segment: 'Extract',
  model3d: 'Generate 3D',
  panorama: 'Generate Panorama',
  rig: 'Rig + Animate',
  sound: 'Add Sound',
  merge: 'Merge',
  llm: 'Run LLM',
  vision: 'Analyze',
  data: 'Extract Data',
  training: 'Train',
  workflow: 'Run Workflow',
  other: 'Run',
};

type Drill = { type: 'category'; value: string } | { type: 'provider'; value: string } | null;

/** Which Browse tab is showing. Lives in App, not here — see HomeScreen's props. */
export type BrowseMode = 'category' | 'provider' | 'apps';

/** A "For your selection" capture-tool card — icon is its capability, in a
 *  tone-tinted chip (matching the design's context tools). */
function ToolCard({
  capability,
  title,
  sub,
  onOpen,
}: {
  capability: Capability;
  title: string;
  sub: string;
  onOpen: () => void;
}) {
  const tone = toneOf(capability);
  return (
    <div
      className="card"
      role="button"
      tabIndex={0}
      title={title}
      onClick={onOpen}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onOpen()}
    >
      <span className="tool-icon" style={{ background: toneFill(tone), border: `1px solid ${toneOutline(tone)}` }}>
        <CapabilityIcon capability={capability} color={tone} size={17} />
      </span>
      <div className="card-body">
        <div className="card-title">{title}</div>
        <div className="card-sub">{sub}</div>
      </div>
    </div>
  );
}

/** A model row used in search results — a single task, selected directly. */
function ModelRow({ model, onSelect }: { model: FalModel; onSelect: (m: FalModel) => void }) {
  return (
    <div
      className="card"
      role="button"
      tabIndex={0}
      title={model.endpointId}
      onClick={() => onSelect(model)}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onSelect(model)}
    >
      <span className="cap-dot" style={{ background: toneOf(model.capability) }} />
      <div className="card-body">
        <div className="card-title">
          {CAPABILITY_VERB[model.capability]} · {model.label}
        </div>
        <div className="card-sub">{model.endpointId}</div>
      </div>
    </div>
  );
}

/** A family (= model) row in a category/provider drill-down. */
function FamilyRow({
  family,
  showProvider,
  onSelect,
}: {
  family: ModelFamily;
  showProvider: boolean;
  onSelect: (key: string) => void;
}) {
  const tone = toneOf(family.capabilities[0]);
  const sub = showProvider ? family.provider : family.categories.join(' · ');
  const fav = isFavourite(family.key);
  return (
    <div
      className="card"
      role="button"
      tabIndex={0}
      title={family.name}
      onClick={() => onSelect(family.key)}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onSelect(family.key)}
    >
      <span className="cap-dot" style={{ background: tone }} />
      <div className="card-body">
        <div className="card-title">{family.name}</div>
        <div className="card-sub">{sub}</div>
      </div>
      <span className="count-pill">
        {family.tasks.length} task{family.tasks.length === 1 ? '' : 's'}
      </span>
      <button
        type="button"
        className={`fav-star ${fav ? 'on' : ''}`}
        aria-label={fav ? 'Unfavourite' : 'Favourite'}
        aria-pressed={fav}
        title={fav ? 'Remove from favourites' : 'Add to favourites'}
        onClick={(e) => {
          e.stopPropagation();
          toggleFavourite(family.key);
        }}
      >
        {fav ? '★' : '☆'}
      </button>
    </div>
  );
}

/**
 * Home screen: browse by Category ↔ by Provider ↔ drill into one (listing the
 * models/families), with search as an overlay and a selection-aware "For your
 * selection" zone on top.
 */
export function HomeScreen({
  onSelectFamily,
  onSelectModel,
  onOpenTool,
  onOpenScene,
  onOpenSettings,
  onOpenRecipe,
  onOpenApp,
  browseMode,
  onBrowseModeChange,
}: {
  onSelectFamily: (familyKey: string) => void;
  onSelectModel: (m: FalModel) => void;
  onOpenTool: (tool: CaptureTool, itemId: string) => void;
  onOpenScene: () => void;
  onOpenSettings: () => void;
  onOpenRecipe: (recipe: RecipeCard, cardId: string) => void;
  /** Opens a bespoke pipeline-app screen (Browse ▸ Apps) by its pipelineApps.ts id. */
  onOpenApp?: (appId: string) => void;
  /** Which Browse tab is showing. Owned by App so it survives opening an app
   *  and coming back — this screen unmounts entirely while an app is open, so
   *  local state here would silently reset the user to Category. */
  browseMode: BrowseMode;
  onBrowseModeChange: (mode: BrowseMode) => void;
}) {
  useCatalogVersion(); // re-render Browse when the curation filter changes
  const [query, setQuery] = useState('');
  const [drill, setDrill] = useState<Drill>(null);
  const [appsNote, setAppsNote] = useState<string | null>(null);

  // Selection-aware capture tools — all of them load their source cross-origin
  // through the backend's /proxy route (Fal's CDN sends no CORS headers), so
  // they're mothballed in client mode rather than left to fail silently.
  const captureAvailable = connectionMode() !== 'client';
  const selectedEmbed = useFirstSelected<{ id: string; url?: string }>('embed');
  const has3dViewerSelected = captureAvailable && Boolean(selectedEmbed?.url && unwrapModel3dEmbedUrl(selectedEmbed.url));
  const hasVideoSelected = captureAvailable && Boolean(selectedEmbed?.url && unwrapVideoEmbedUrl(selectedEmbed.url));
  const hasPanoramaSelected = captureAvailable && Boolean(selectedEmbed?.url && unwrapPanoramaEmbedUrl(selectedEmbed.url));
  const hasRigSelected = captureAvailable && Boolean(selectedEmbed?.url && unwrapRigEmbedUrl(selectedEmbed.url));

  // Selection-aware settings-card reopen — a Card whose description parses as
  // a recipe (see recipeCard.ts) offers to jump back into its model screen.
  const selectedCard = useFirstSelected<{ id: string; description?: string }>('card');
  const selectedRecipe = useMemo(() => parseRecipeCard(selectedCard?.description), [selectedCard]);
  const recipeModelLabel = selectedRecipe
    ? findModel(selectedRecipe.endpointId)?.label ?? selectedRecipe.endpointId.replace(/^fal-ai\//, '')
    : '';

  const selectedEmbeds = useSelectedItems<{ id: string; url?: string; title?: string }>('embed');
  // Scene Builder also loads its assets through /proxy — same mothballing rule.
  const sceneAssets = !captureAvailable
    ? []
    : (selectedEmbeds
        .map((e) => {
          const glb = e.url ? unwrapModel3dEmbedUrl(e.url) ?? unwrapRigEmbedUrl(e.url) : null;
          return glb ? { id: e.id, url: glb, name: e.title } : null;
        })
        .filter(Boolean) as Array<{ id: string; url: string; name?: string }>);
  const scenePanorama = !captureAvailable
    ? undefined
    : (selectedEmbeds.map((e) => (e.url ? unwrapPanoramaEmbedUrl(e.url) : null)).find(Boolean) as string | undefined);

  const openScene = async () => {
    await setSceneInputs({
      assets: sceneAssets.map((a) => ({ url: a.url, name: a.name })),
      panorama: scenePanorama ?? null,
      anchorItemId: sceneAssets[0]?.id ?? null,
    });
    onOpenScene();
  };

  const q = query.trim().toLowerCase();
  const searching = q.length > 0;
  const results = useMemo(() => {
    if (!searching) return [];
    return enabledModels().filter(
      (m) =>
        m.label.toLowerCase().includes(q) ||
        m.capability.includes(q) ||
        providerOf(m.endpointId).toLowerCase().includes(q) ||
        m.endpointId.toLowerCase().includes(q),
    );
  }, [q, searching]);

  const drilledFamilies = useMemo(() => {
    if (drill?.type === 'category') return familiesByCategory(drill.value);
    if (drill?.type === 'provider') return familiesByProvider(drill.value);
    return [];
  }, [drill]);

  const drillTitle = drill?.value ?? '';
  const drillCount = drilledFamilies.length;

  const hasSelectionZone =
    Boolean(selectedRecipe) ||
    (Boolean(selectedEmbed) &&
      (has3dViewerSelected || hasVideoSelected || hasPanoramaSelected || hasRigSelected || sceneAssets.length >= 1));

  return (
    <div className="screen">
      <input
        className="search"
        placeholder="Search models — e.g. Nano Banana, video, Google…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      {hasSelectionZone && (
        <div className="sel-zone">
          <span className="eyebrow">For your selection</span>
          {selectedRecipe && selectedCard && (
            <ToolCard
              capability={selectedRecipe.capability}
              title={`Reopen · ${recipeModelLabel}`}
              sub="Load this settings card back into its model screen"
              onOpen={() => onOpenRecipe(selectedRecipe, selectedCard.id)}
            />
          )}
          {selectedEmbed && has3dViewerSelected && (
            <ToolCard
              capability="model3d"
              title="3D Viewer → Image"
              sub="Orbit the model and capture the angle to the board"
              onOpen={() => onOpenTool('viewer3d-to-image', selectedEmbed.id)}
            />
          )}
          {selectedEmbed && hasVideoSelected && (
            <ToolCard
              capability="video"
              title="Video Player → Image"
              sub="Scrub the video and capture a frame (e.g. the last)"
              onOpen={() => onOpenTool('video-to-image', selectedEmbed.id)}
            />
          )}
          {selectedEmbed && hasPanoramaSelected && (
            <ToolCard
              capability="panorama"
              title="Panorama Viewer → Image"
              sub="Look around the 360° scene and capture a background"
              onOpen={() => onOpenTool('panorama-to-image', selectedEmbed.id)}
            />
          )}
          {selectedEmbed && hasRigSelected && (
            <ToolCard
              capability="rig"
              title="Rig Viewer → Image (animate)"
              sub="Play/scrub an animation to a pose and capture it"
              onOpen={() => onOpenTool('rig-to-image', selectedEmbed.id)}
            />
          )}
          {selectedEmbed && hasRigSelected && (
            <ToolCard
              capability="rig"
              title="Pose Character (manual)"
              sub="Rotate individual joints to build a custom pose"
              onOpen={() => onOpenTool('pose-character', selectedEmbed.id)}
            />
          )}
          {sceneAssets.length >= 1 && (
            <ToolCard
              capability="model3d"
              title="Scene Builder"
              sub={`Arrange ${sceneAssets.length} model${sceneAssets.length === 1 ? '' : 's'}${
                scenePanorama ? ' + panorama' : ''
              } → capture the scene`}
              onOpen={() => void openScene()}
            />
          )}
        </div>
      )}

      {/* Search overlay — takes precedence over browse/drill. */}
      {searching ? (
        <>
          <span className="label">
            {results.length} model result{results.length === 1 ? '' : 's'}
          </span>
          {results.map((m) => (
            <ModelRow key={`${m.endpointId}·${m.task ?? m.label}`} model={m} onSelect={onSelectModel} />
          ))}
          {results.length === 0 && <div className="notice">Nothing matches “{query}”.</div>}
        </>
      ) : drill ? (
        // Drill-down: families in this category/provider.
        <>
          <div className="drill-head">
            <button type="button" className="back-link" onClick={() => setDrill(null)}>
              ← All
            </button>
            <span className="drill-title">{drillTitle}</span>
            <span className="count-pill">{drillCount}</span>
          </div>
          {drilledFamilies.map((f) => (
            <FamilyRow key={f.key} family={f} showProvider={drill.type === 'category'} onSelect={onSelectFamily} />
          ))}
        </>
      ) : (
        // Browse grid — by category or by provider, with favourites on top.
        <>
          {favouriteFamilies().length > 0 && (
            <>
              <span className="label">★ Favourites</span>
              {favouriteFamilies().map((f) => (
                <FamilyRow key={`fav-${f.key}`} family={f} showProvider onSelect={onSelectFamily} />
              ))}
            </>
          )}

          <div className="seg">
            <button
              type="button"
              className={browseMode === 'category' ? 'active' : ''}
              onClick={() => onBrowseModeChange('category')}
            >
              Category
            </button>
            <button
              type="button"
              className={browseMode === 'provider' ? 'active' : ''}
              onClick={() => onBrowseModeChange('provider')}
            >
              Provider
            </button>
            <button
              type="button"
              className={browseMode === 'apps' ? 'active' : ''}
              onClick={() => onBrowseModeChange('apps')}
            >
              Apps
            </button>
          </div>

          <div className="tiles">
            {browseMode === 'category' &&
              categoriesPresent().map((c) => {
                const count = familiesByCategory(c).length;
                const cap = capabilityForCategory(c);
                const tone = toneOf(cap);
                return (
                  <div
                    key={c}
                    className="tile"
                    role="button"
                    tabIndex={0}
                    onClick={() => setDrill({ type: 'category', value: c })}
                    onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && setDrill({ type: 'category', value: c })}
                  >
                    <span
                      className="tile-icon"
                      style={{ background: toneFill(tone), border: `1px solid ${toneOutline(tone)}` }}
                    >
                      <CapabilityIcon capability={cap} color={tone} size={18} />
                    </span>
                    <span className="tile-label">{c}</span>
                    <span className="tile-count">
                      {count} model{count === 1 ? '' : 's'}
                    </span>
                  </div>
                );
              })}

            {browseMode === 'provider' &&
              providersPresent().map((p) => {
                const count = familiesByProvider(p).length;
                return (
                  <div
                    key={p}
                    className="tile"
                    role="button"
                    tabIndex={0}
                    onClick={() => setDrill({ type: 'provider', value: p })}
                    onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && setDrill({ type: 'provider', value: p })}
                  >
                    <ProviderLogo provider={p} />
                    <span className="tile-label">{p}</span>
                    <span className="tile-count">
                      {count} model{count === 1 ? '' : 's'}
                    </span>
                  </div>
                );
              })}

            {browseMode === 'apps' && onOpenApp && (
              <div
                className="tile"
                role="button"
                tabIndex={0}
                onClick={() => onOpenApp('sketch-to-tryon')}
                onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onOpenApp('sketch-to-tryon')}
              >
                <span
                  className="tile-icon"
                  style={{ background: toneFill(toneOf('image')), border: `1px solid ${toneOutline(toneOf('image'))}` }}
                >
                  <CapabilityIcon capability="image" color={toneOf('image')} size={18} />
                </span>
                <span className="tile-label">Sketch to Try-On</span>
                <span className="tile-count">app · 2 steps</span>
              </div>
            )}

            {browseMode === 'apps' && onOpenApp && (
              <div
                className="tile"
                role="button"
                tabIndex={0}
                onClick={() => onOpenApp('mask-creator')}
                onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onOpenApp('mask-creator')}
              >
                <span
                  className="tile-icon"
                  style={{ background: toneFill(toneOf('segment')), border: `1px solid ${toneOutline(toneOf('segment'))}` }}
                >
                  <CapabilityIcon capability="segment" color={toneOf('segment')} size={18} />
                </span>
                <span className="tile-label">Create Mask</span>
                <span className="tile-count">app · 1 step</span>
              </div>
            )}

            {browseMode === 'apps' && onOpenApp && (
              <div
                className="tile"
                role="button"
                tabIndex={0}
                onClick={() => onOpenApp('nano-banana-pattern')}
                onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onOpenApp('nano-banana-pattern')}
              >
                <span
                  className="tile-icon"
                  style={{ background: toneFill(toneOf('image')), border: `1px solid ${toneOutline(toneOf('image'))}` }}
                >
                  <CapabilityIcon capability="image" color={toneOf('image')} size={18} />
                </span>
                <span className="tile-label">Nano Banana Pattern</span>
                <span className="tile-count">app · 1 step</span>
              </div>
            )}

            {browseMode === 'apps' && onOpenApp && (
              <div
                className="tile"
                role="button"
                tabIndex={0}
                onClick={() => onOpenApp('pattern-fill')}
                onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onOpenApp('pattern-fill')}
              >
                <span
                  className="tile-icon"
                  style={{ background: toneFill(toneOf('image')), border: `1px solid ${toneOutline(toneOf('image'))}` }}
                >
                  <CapabilityIcon capability="image" color={toneOf('image')} size={18} />
                </span>
                <span className="tile-label">Pattern Fill</span>
                <span className="tile-count">app · no credits</span>
              </div>
            )}

            {browseMode === 'apps' && onOpenApp && (
              <div
                className="tile"
                role="button"
                tabIndex={0}
                onClick={() => onOpenApp('add-video-from-url')}
                onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onOpenApp('add-video-from-url')}
              >
                <span
                  className="tile-icon"
                  style={{ background: toneFill(toneOf('video')), border: `1px solid ${toneOutline(toneOf('video'))}` }}
                >
                  <CapabilityIcon capability="video" color={toneOf('video')} size={18} />
                </span>
                <span className="tile-label">Add Video from URL</span>
                <span className="tile-count">app · no credits</span>
              </div>
            )}

            {browseMode === 'apps' && (
              <div
                className="tile"
                role="button"
                tabIndex={0}
                onClick={() => {
                  if (hasRigSelected && selectedEmbed) {
                    setAppsNote(null);
                    onOpenTool('rig-to-image', selectedEmbed.id);
                  } else {
                    setAppsNote('Select a rigged character (an animated 3D viewer) on the board first, then click this again.');
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' && e.key !== ' ') return;
                  if (hasRigSelected && selectedEmbed) {
                    setAppsNote(null);
                    onOpenTool('rig-to-image', selectedEmbed.id);
                  } else {
                    setAppsNote('Select a rigged character (an animated 3D viewer) on the board first, then click this again.');
                  }
                }}
              >
                <span
                  className="tile-icon"
                  style={{ background: toneFill(toneOf('rig')), border: `1px solid ${toneOutline(toneOf('rig'))}` }}
                >
                  <CapabilityIcon capability="rig" color={toneOf('rig')} size={18} />
                </span>
                <span className="tile-label">Rig Viewer → Image</span>
                <span className="tile-count">app · capture tool</span>
              </div>
            )}
          </div>
          {browseMode === 'apps' && appsNote && <div className="notice">{appsNote}</div>}
        </>
      )}

      <SelectionTools />

      {!searching && !drill && (
        <button type="button" className="reset-link settings-link" onClick={onOpenSettings}>
          ⚙ Settings
        </button>
      )}
    </div>
  );
}
