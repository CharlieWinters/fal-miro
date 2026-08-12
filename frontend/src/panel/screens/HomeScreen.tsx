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
import { resolveTargets, useCasesPresent } from '../../shared/useCases';
import { toggleFavourite } from '../favourites';
import { SelectionTools } from '../SelectionTools';
import { ProviderLogo } from '../ProviderLogo';
import { useCatalogVersion } from '../hooks/useCatalog';
import { useFirstSelected, useSelectedItems } from '../hooks/useSelection';
import {
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
};

type Drill =
  | { type: 'category'; value: string }
  | { type: 'provider'; value: string }
  | { type: 'usecase'; value: string }
  | null;

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

/** A use-case row in search results — opens the case (or its chooser). */
function UseCaseRow({ label, tone, count, onOpen }: { label: string; tone: string; count: number; onOpen: () => void }) {
  return (
    <div
      className="card"
      role="button"
      tabIndex={0}
      title={label}
      onClick={onOpen}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onOpen()}
    >
      <span className="cap-dot" style={{ background: tone }} />
      <div className="card-body">
        <div className="card-title">{label}</div>
        <div className="card-sub">
          Use case · {count} model{count === 1 ? '' : 's'}
        </div>
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
}: {
  onSelectFamily: (familyKey: string) => void;
  onSelectModel: (m: FalModel) => void;
  onOpenTool: (tool: CaptureTool, itemId: string) => void;
  onOpenScene: () => void;
  onOpenSettings: () => void;
  onOpenRecipe: (recipe: RecipeCard, cardId: string) => void;
}) {
  useCatalogVersion(); // re-render Browse when the curation filter changes
  const [query, setQuery] = useState('');
  const [browseMode, setBrowseMode] = useState<'category' | 'provider' | 'usecase'>('category');
  const [drill, setDrill] = useState<Drill>(null);

  // Selection-aware capture tools (unchanged).
  const selectedEmbed = useFirstSelected<{ id: string; url?: string }>('embed');
  const has3dViewerSelected = Boolean(selectedEmbed?.url && unwrapModel3dEmbedUrl(selectedEmbed.url));
  const hasVideoSelected = Boolean(selectedEmbed?.url && unwrapVideoEmbedUrl(selectedEmbed.url));
  const hasPanoramaSelected = Boolean(selectedEmbed?.url && unwrapPanoramaEmbedUrl(selectedEmbed.url));
  const hasRigSelected = Boolean(selectedEmbed?.url && unwrapRigEmbedUrl(selectedEmbed.url));

  // Selection-aware settings-card reopen — a Card whose description parses as
  // a recipe (see recipeCard.ts) offers to jump back into its model screen.
  const selectedCard = useFirstSelected<{ id: string; description?: string }>('card');
  const selectedRecipe = useMemo(() => parseRecipeCard(selectedCard?.description), [selectedCard]);
  const recipeModelLabel = selectedRecipe
    ? findModel(selectedRecipe.endpointId)?.label ?? selectedRecipe.endpointId.replace(/^fal-ai\//, '')
    : '';

  const selectedEmbeds = useSelectedItems<{ id: string; url?: string; title?: string }>('embed');
  const sceneAssets = selectedEmbeds
    .map((e) => {
      const glb = e.url ? unwrapModel3dEmbedUrl(e.url) ?? unwrapRigEmbedUrl(e.url) : null;
      return glb ? { id: e.id, url: glb, name: e.title } : null;
    })
    .filter(Boolean) as Array<{ id: string; url: string; name?: string }>;
  const scenePanorama = selectedEmbeds
    .map((e) => (e.url ? unwrapPanoramaEmbedUrl(e.url) : null))
    .find(Boolean) as string | undefined;

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

  const matchedUseCases = useMemo(() => {
    if (!searching) return [];
    return useCasesPresent().filter((uc) => uc.label.toLowerCase().includes(q));
  }, [q, searching]);

  const drilledFamilies = useMemo(() => {
    if (drill?.type === 'category') return familiesByCategory(drill.value);
    if (drill?.type === 'provider') return familiesByProvider(drill.value);
    return [];
  }, [drill]);

  // Use-case drill: resolve the use case to its candidate tasks.
  const drilledUseCase = drill?.type === 'usecase' ? useCasesPresent().find((u) => u.id === drill.value) : undefined;
  const drilledTargets = useMemo(() => (drilledUseCase ? resolveTargets(drilledUseCase) : []), [drilledUseCase]);
  const drillTitle = drill ? (drill.type === 'usecase' ? drilledUseCase?.label ?? drill.value : drill.value) : '';
  const drillCount = drill?.type === 'usecase' ? drilledTargets.length : drilledFamilies.length;

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
          {matchedUseCases.length > 0 && (
            <>
              <span className="label">Use cases</span>
              {matchedUseCases.map((uc) => {
                const targets = resolveTargets(uc);
                const open = () => {
                  if (targets.length === 1) {
                    onSelectModel(targets[0]);
                  } else {
                    setQuery('');
                    setDrill({ type: 'usecase', value: uc.id });
                  }
                };
                return (
                  <UseCaseRow key={uc.id} label={uc.label} tone={toneOf(uc.icon)} count={targets.length} onOpen={open} />
                );
              })}
            </>
          )}

          <span className="label">
            {results.length} model result{results.length === 1 ? '' : 's'}
          </span>
          {results.map((m) => (
            <ModelRow key={`${m.endpointId}·${m.task ?? m.label}`} model={m} onSelect={onSelectModel} />
          ))}
          {results.length === 0 && matchedUseCases.length === 0 && (
            <div className="notice">Nothing matches “{query}”.</div>
          )}
        </>
      ) : drill ? (
        // Drill-down: families (category/provider) or candidate tasks (use case).
        <>
          <div className="drill-head">
            <button type="button" className="back-link" onClick={() => setDrill(null)}>
              ← All
            </button>
            <span className="drill-title">{drillTitle}</span>
            <span className="count-pill">{drillCount}</span>
          </div>
          {drill.type === 'usecase'
            ? drilledTargets.map((m) => (
                <ModelRow key={`${m.endpointId}·${m.task ?? m.label}`} model={m} onSelect={onSelectModel} />
              ))
            : drilledFamilies.map((f) => (
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
              onClick={() => setBrowseMode('category')}
            >
              Category
            </button>
            <button
              type="button"
              className={browseMode === 'provider' ? 'active' : ''}
              onClick={() => setBrowseMode('provider')}
            >
              Provider
            </button>
            <button
              type="button"
              className={browseMode === 'usecase' ? 'active' : ''}
              onClick={() => setBrowseMode('usecase')}
            >
              Use case
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

            {browseMode === 'usecase' &&
              useCasesPresent().map((uc) => {
                const targets = resolveTargets(uc);
                const tone = toneOf(uc.icon);
                const open = () =>
                  targets.length === 1 ? onSelectModel(targets[0]) : setDrill({ type: 'usecase', value: uc.id });
                return (
                  <div
                    key={uc.id}
                    className="tile"
                    role="button"
                    tabIndex={0}
                    onClick={open}
                    onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && open()}
                  >
                    <span
                      className="tile-icon"
                      style={{ background: toneFill(tone), border: `1px solid ${toneOutline(tone)}` }}
                    >
                      <CapabilityIcon capability={uc.icon} color={tone} size={18} />
                    </span>
                    <span className="tile-label">{uc.label}</span>
                    <span className="tile-count">
                      {targets.length} model{targets.length === 1 ? '' : 's'}
                    </span>
                  </div>
                );
              })}
          </div>
        </>
      )}

      <SelectionTools />

      {!searching && !drill && (
        <button type="button" className="reset-link settings-link" onClick={onOpenSettings}>
          ⚙ Curate models…
        </button>
      )}
    </div>
  );
}
