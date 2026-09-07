import { useEffect, useMemo, useState } from 'react';
import { startAgentJob } from '../communication';

import { BasketPanel } from '../Basket';
import { PromptBasket, assemblePrompt } from '../PromptBasket';
import { useBasket } from '../hooks/basket';
import { useBoardSelection } from '../hooks/boardSelection';
import { SchemaForm } from '../SchemaForm';
import { api } from '../../lib/api';
import {
  connectItemsToCard,
  createCardBelow,
  getConnectedReferenceImages,
  resolveBoardItems,
} from '../../shared/boardHelpers';
import {
  RECIPE_CARD_VERSION,
  resolveStickyFieldOverrides,
  serializeRecipeCard,
  type RecipeCard,
  type RecipeSeed,
} from '../../shared/recipeCard';
import { COMMON_ARGS, type FalModel } from '../../shared/falCatalog';
import {
  parseFalInputSchema,
  defaultsFor,
  pickReferenceField,
  pickVideoReferenceField,
  pickViewImageFields,
  type Field,
} from '../../shared/schema';
import {
  DEFAULT_ASSET_NAMING,
  compileAssetPattern,
  extractAssetName,
  stripAssetName,
  type AssetNamingConfig,
} from '../../shared/assetNaming';
import { getAssetNamingConfig, setAssetNamingConfig } from '../../shared/storage';

type ImageItem = { id: string; title?: string };
type EmbedItem = { id: string; url?: string; title?: string };

type SchemaState =
  | { status: 'loading' }
  | { status: 'ready'; fields: Field[] }
  | { status: 'fallback'; fields: Field[]; error: string };

const PROMPT_FALLBACK: Field[] = [{ name: 'prompt', label: 'Prompt', kind: 'text', required: true }];

const SIZE_TO_RATIO: Record<string, string> = {
  square: '1:1',
  square_hd: '1:1',
  landscape_4_3: '4:3',
  landscape_16_9: '16:9',
  portrait_4_3: '3:4',
  portrait_16_9: '9:16',
};

export function ImageGenScreen({ model, seed }: { model: FalModel; seed?: RecipeSeed | null }) {
  // Always call selection hooks (can't be conditional); pick what matters below.
  // Frame-aware: a prompt sticky left inside a "prompt frame" is picked up
  // the moment the frame is selected, not just when the sticky itself is.
  // Frame-aware: a selected frame's images/Fal-video embeds count as
  // references too, same rule as ReferenceToVideoScreen/GenericModelScreen —
  // unlike useSelectedItems, which only sees literally-selected items.

  // A reopened settings card's connected images/videos — used as a fallback
  // source until the user selects something directly on the board themselves.

  const [schema, setSchema] = useState<SchemaState>({ status: 'loading' });
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [refCount, setRefCount] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  // Multi-view models: board image assigned to each named view field.
  const [views, setViews] = useState<Record<string, { id: string; title?: string }>>({});
  // Asset naming: the board's regex config + the name that will title the image.
  const [assetCfg, setAssetCfg] = useState<AssetNamingConfig>(DEFAULT_ASSET_NAMING);
  const [assetName, setAssetName] = useState('');
  const [assetEdited, setAssetEdited] = useState(false);

  // Fetch the live schema for this model.
  useEffect(() => {
    let mounted = true;
    setSchema({ status: 'loading' });
    api
      .getSchema(model.endpointId)
      .then((res) => {
        if (!mounted) return;
        const fields = parseFalInputSchema(res.openapi);
        if (fields.length === 0) {
          setSchema({ status: 'fallback', fields: PROMPT_FALLBACK, error: 'Schema had no inputs.' });
          setValues({});
        } else {
          setSchema({ status: 'ready', fields });
          setValues(defaultsFor(fields));
        }
      })
      .catch((err) => {
        if (!mounted) return;
        setSchema({ status: 'fallback', fields: PROMPT_FALLBACK, error: String(err?.message ?? err) });
        setValues({});
      });
    return () => {
      mounted = false;
    };
  }, [model.endpointId]);

  // Reopening a settings card pre-fills the baskets and stops there. There's
  // no "from this card" state to reason about — it's just a list that arrived
  // with items already in it, editable like any other. Each reopen gets a
  // fresh token, so this reruns even for the same card twice in a row.
  useEffect(() => {
    if (!seed) return;
    imageBasket.replace(seed.images);
    videoBasket.replace(seed.videos);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed?.token]);

  // Merge the seed's static input over the schema defaults once they're
  // loaded, then apply any connected-sticky field overrides (e.g. a "Seed:
  // 42" or "Prompt: …" sticky) — those win over the frozen input snapshot,
  // since they reflect what's connected right now.
  useEffect(() => {
    if (!seed || schema.status === 'loading') return;
    const overrides = resolveStickyFieldOverrides(seed.stickies, fields);
    const merged = { ...seed.input, ...overrides } as Record<string, unknown>;
    if (typeof merged.prompt === 'string') setPromptText(merged.prompt);
    setValues((v) => ({ ...v, ...merged }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed?.token, schema.status]);

  const fields = schema.status === 'loading' ? [] : schema.fields;
  const hasPromptField = useMemo(() => fields.some((f) => f.name === 'prompt'), [fields]);
  const referenceField = useMemo(() => pickReferenceField(fields), [fields]);
  const videoReferenceField = useMemo(() => pickVideoReferenceField(fields), [fields]);
  const isVideo = model.capability === 'video';
  const isSegment = model.capability === 'segment';
  const is3d = model.capability === 'model3d';
  const isPanorama = model.capability === 'panorama';
  // Whether this model routes to fal_image_gen (which names the finished image).
  const usesImageAgent = !isVideo && !is3d && !isPanorama;
  // Multi-view (e.g. Hunyuan3D v3): several named single-image fields → a slot
  // per view (front + back/left/right) instead of one selector. 3D-only — for
  // video, a second image field (e.g. Seedance's end_image_url) is the start+end
  // flow, which has its own two-frame screen.
  const viewFields = useMemo(() => (is3d ? pickViewImageFields(fields) : []), [fields, is3d]);
  const multiView = viewFields.length >= 2;
  // Frame-aware, unlike a plain multi-select — a "References" frame full of
  // images works the same as shift-clicking each one.
  // Image-primary: the model *requires* an image, so the image is the subject
  // (Runway-style — select one on the board), not an optional URL field.
  // `generate` models force text-primary even if the schema marks an image required.
  const imagePrimary = !model.generate && Boolean(referenceField?.required) && !multiView;
  // Whether the schema has an image input at all — offer the board picker even
  // when it's *optional* (e.g. Nano Banana 2 generate takes optional image_urls),
  // not only when it's the required subject. `takesMulti` = an array field
  // (several references), `takesSingle` = one image.
  const takesMulti = Boolean(referenceField?.multiple) && !multiView;
  const takesSingle = Boolean(referenceField) && !referenceField?.multiple && !multiView;
  // Image is mandatory (block generate until one's chosen) only when required.
  const imageRequired = imagePrimary;

  // Same pattern as images, for video-to-video / video-edit models whose
  // primary input is a `video_url`-shaped field (e.g. Google Omni Video Edit)
  // rather than an image. A selected board item only counts as a candidate
  // when it's a Fal-generated video embed (unwrapVideoEmbedUrl succeeds).

  // Already filtered to Fal-video embeds by collectBoardReferences, and
  // frame-aware for the same reason as selectedImages above.
  const videoPrimary = !model.generate && Boolean(videoReferenceField?.required) && !multiView;
  const takesMultiVideo = Boolean(videoReferenceField?.multiple) && !multiView;
  const takesSingleVideo = Boolean(videoReferenceField) && !videoReferenceField?.multiple && !multiView;
  const videoRequired = videoPrimary;

  // Reference baskets — ordered lists the user builds, one per input. See
  // hooks/basket.ts. Nothing mirrors the selection, so clicking around the
  // board costs no SDK calls at all; the baskets only read it on Add.
  const boardSel = useBoardSelection();
  const imageBasket = useBasket('image', boardSel);
  const videoBasket = useBasket('video', boardSel);
  const noteBasket = useBasket('note', boardSel);
  const [promptText, setPromptText] = useState('');
  /** Notes (in basket order) + the typed text — what actually gets sent. */
  const fullPrompt = assemblePrompt(noteBasket, promptText);

  // Everything downstream — validation, the request, lineage, the cost
  // preview — reads the basket, which is the user's explicit list.
  const effectiveSelectedImages: ImageItem[] = imageBasket.items.map((i) => ({ id: i.id, title: i.label }));
  const effectiveSourceImage: ImageItem | null = effectiveSelectedImages[0] ?? null;
  const effectiveSelectedVideos: EmbedItem[] = videoBasket.items.map((i) => ({ id: i.id, title: i.label }));
  const effectiveSourceVideo: EmbedItem | null = effectiveSelectedVideos[0] ?? null;

  // The frame the current references came from, if any — live selection
  // wins, else falls back to the reopened card's own frame. Lets the output
  // place below that frame, sized to match, instead of trailing one item.
  const referenceFrameId = seed?.frameId ?? undefined;

  // Reset view-slot assignments when switching models.
  useEffect(() => {
    setViews({});
  }, [model.endpointId]);

  // Selected stickies, ordered left-to-right (first sticky → start of prompt).


  // Count the reference images that will be sent.
  useEffect(() => {
    let mounted = true;
    const anchor = effectiveSourceImage?.id;
    if (!referenceField || !anchor) {
      setRefCount(0);
      return;
    }
    getConnectedReferenceImages(anchor)
      .then((imgs) => {
        if (!mounted) return;
        // image-primary: the selected image itself + any others connected to it.
        const base = imagePrimary ? 1 : 0;
        const extras = imagePrimary
          ? imgs.filter((i) => i.miroImageId !== effectiveSourceImage?.id).length
          : imgs.length;
        setRefCount(base + extras);
      })
      .catch(() => mounted && setRefCount(imagePrimary ? 1 : 0));
    return () => {
      mounted = false;
    };
  }, [imagePrimary, effectiveSourceImage, referenceField]);

  // Load the board's asset-naming config once.
  useEffect(() => {
    let mounted = true;
    getAssetNamingConfig()
      .then((cfg) => mounted && setAssetCfg(cfg))
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, []);

  const detectedAsset = useMemo(() => extractAssetName(fullPrompt, assetCfg), [fullPrompt, assetCfg]);

  // Follow the auto-detected name until the user types their own.
  useEffect(() => {
    if (!assetEdited) setAssetName(detectedAsset ?? '');
  }, [detectedAsset, assetEdited]);

  /**
   * Why Generate can't run yet, or null. Drives both the disabled button and
   * the message, so a missing required input is visible *before* the click
   * rather than only as an error after it — an edit model with an empty image
   * basket is the common case.
   */
  const blockReason: string | null = (() => {
    // A row whose board item was deleted would send a dead reference.
    if (imageBasket.hasMissing) return 'An image in the basket is no longer on the board — remove it first.';
    if (videoBasket.hasMissing) return 'A video in the basket is no longer on the board — remove it first.';
    if (noteBasket.hasMissing) return 'A sticky note in the prompt is no longer on the board — remove it first.';
    if (imageRequired && effectiveSelectedImages.length === 0) {
      return `Add ${takesMulti ? 'one or more images' : 'an image'} to the Image basket first — select on the board, then press Add.`;
    }
    if (videoRequired && effectiveSelectedVideos.length === 0) {
      return `Add ${takesMultiVideo ? 'one or more Fal videos' : 'a Fal video'} to the Video basket first — select on the board, then press Add.`;
    }
    if (multiView) {
      const missing = viewFields.find((f) => f.required && !views[f.name]);
      if (missing) return `Assign an image to the required "${missing.label}" view.`;
    }
    // Only demand a prompt when there is somewhere to type one. A model with no
    // `prompt` field renders no prompt basket (see hasPromptField below), so
    // asking for one is a dead end -- the button can never be enabled. Same for
    // multiView: the required view slot *is* the primary input, exactly as
    // imagePrimary is for the single-image models.
    if (hasPromptField && !multiView && !fullPrompt.trim() && !imagePrimary && !videoPrimary) {
      return 'Type a prompt, or add sticky notes to the prompt basket.';
    }
    return null;
  })();

  const onChange = (name: string, value: unknown) => {
    setValues((v) => ({ ...v, [name]: value }));
  };

  const onGenerate = () => {
    setNote(null);
    if (blockReason) {
      setNote(blockReason);
      return;
    }
    let input: Record<string, unknown>;
    try {
      input = buildInput(fields, values);
      // The prompt basket owns this field, so inject the assembled value
      // (notes in basket order, then the typed text) rather than reading
      // `values`, which SchemaForm no longer writes into.
      if (hasPromptField && fullPrompt.trim()) input.prompt = fullPrompt;
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'Invalid input.');
      return;
    }
    // When an asset id names the image, drop its prefix from the prompt so only
    // the description reaches the model (ASSET_ID, prompt… → prompt…).
    if (usesImageAgent && assetName.trim() && typeof input.prompt === 'string') {
      const stripped = stripAssetName(input.prompt, assetCfg);
      if (stripped.trim()) input.prompt = stripped;
    }
    startAgentJob({
      agentId: isPanorama
        ? 'fal_image_to_panorama'
        : is3d
          ? 'fal_image_to_3d'
          : isVideo
            ? 'fal_video_gen'
            : 'fal_image_gen',
      label: `${model.label} · ${isPanorama ? 'panorama' : is3d ? '3D' : isVideo ? 'video' : isSegment ? 'extract' : 'image'}`,
      kind: isPanorama ? 'panorama' : is3d ? 'model3d' : isVideo ? 'video' : 'image',
      payload: {
        endpointId: model.endpointId,
        stickyId: noteBasket.items[0]?.id,
        sourceImageId: takesSingle ? effectiveSourceImage?.id : undefined,
        sourceImageIds: takesMulti ? effectiveSelectedImages.map((s) => s.id) : undefined,
        sourceVideoId: takesSingleVideo ? effectiveSourceVideo?.id : undefined,
        sourceVideoIds: takesMultiVideo ? effectiveSelectedVideos.map((s) => s.id) : undefined,
        placeholderRatio: ratioFromValues(values),
        input,
        ...(usesImageAgent && assetName.trim() ? { assetName: assetName.trim() } : {}),
        ...(usesImageAgent && referenceFrameId ? { referenceFrameId } : {}),
        ...(referenceField && !multiView ? { referenceField } : {}),
        ...(videoReferenceField && !multiView ? { videoReferenceField } : {}),
        ...(multiView
          ? { viewImages: viewFields.filter((f) => views[f.name]).map((f) => ({ field: f.name, imageId: views[f.name].id })) }
          : {}),
        ...(seed ? { cardAnchorId: seed.cardId } : {}),
      },
    });
    setNote(
      isVideo
        ? 'Video generation started — this takes a few minutes. Watch the board (and the tray above).'
        : is3d
          ? 'Building 3D model — an orbit-able viewer will drop on the board when it’s ready.'
          : isPanorama
            ? 'Building panorama — an interactive 360° viewer will drop on the board when it’s ready.'
            : 'Generation started — watch the board (and the tray above).',
    );
  };

  // Snapshot the model + current inputs as a board Card ("settings card") —
  // connected to whatever fed this screen (images/video/prompt stickies) so a
  // future reopen can detect and re-resolve them. Multi-view (3D) recipes skip
  // the reference fields for now — view-slot assignments aren't captured yet.
  const onSaveCard = async () => {
    setNote(null);
    let input: Record<string, unknown>;
    try {
      input = buildInput(fields, values);
      // The prompt basket owns this field, so inject the assembled value
      // (notes in basket order, then the typed text) rather than reading
      // `values`, which SchemaForm no longer writes into.
      if (hasPromptField && fullPrompt.trim()) input.prompt = fullPrompt;
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'Invalid input.');
      return;
    }

    const recipe: RecipeCard = {
      v: RECIPE_CARD_VERSION,
      endpointId: model.endpointId,
      capability: model.capability,
      input,
      referenceField: !multiView ? referenceField : null,
      videoReferenceField: !multiView ? videoReferenceField : null,
    };

    const connectIds: string[] = [];
    if (takesSingle && effectiveSourceImage) connectIds.push(effectiveSourceImage.id);
    if (takesMulti) connectIds.push(...effectiveSelectedImages.map((s) => s.id));
    if (takesSingleVideo && effectiveSourceVideo) connectIds.push(effectiveSourceVideo.id);
    if (takesMultiVideo) connectIds.push(...effectiveSelectedVideos.map((s) => s.id));
    // Lineage follows what the baskets actually sent, which is by definition
    // what the user put in them.
    connectIds.push(...noteBasket.items.map((n) => n.id));

    // A selected frame's contents count as connected too (mirrors how a
    // connected frame is expanded when reopening a card).
    try {
      const sel = (await miro.board.getSelection()) as Array<{ id: string; type: string }>;
      const frameIds = sel.filter((s) => s.type === 'frame').map((s) => s.id);
      if (frameIds.length) {
        const expanded = await resolveBoardItems(frameIds);
        connectIds.push(
          ...expanded.images.map((i) => i.id),
          ...expanded.videos.map((v) => v.id),
          ...expanded.stickies.map((s) => s.id),
        );
      }
    } catch (e) {
      console.warn('[ImageGenScreen] frame expansion for save failed', e);
    }

    try {
      const { id: cardId } = await createCardBelow({
        sourceItemId: connectIds[0],
        title: `Settings · ${model.label}`,
        description: serializeRecipeCard(recipe),
      });
      if (connectIds.length) await connectItemsToCard(connectIds, cardId);
      setNote('Saved as a settings card on the board.');
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'Failed to save settings card.');
    }
  };

  return (
    <div className="screen">
      <div className="hero">
        <div className="title">{model.label}</div>
        <div className="sub">{model.endpointId}</div>
      </div>


      {schema.status === 'loading' && <div className="notice">Loading model schema…</div>}

      {schema.status !== 'loading' && (
        <>
          {schema.status === 'fallback' && (
            <div className="notice">
              Couldn’t load the live schema ({schema.error}). Falling back to a prompt-only form.
            </div>
          )}

          {/* One basket per media input — an ordered list the user builds. */}
          {(takesSingle || takesMulti) && (
            <BasketPanel
              basket={imageBasket}
              title={takesMulti ? 'Image references' : 'Image'}
              cap={takesSingle ? 1 : undefined}
              onInsertToken={(t) => setPromptText((p) => (p && !/\s$/.test(p) ? `${p} ${t}` : p + t))}
            />
          )}

          {(takesSingleVideo || takesMultiVideo) && (
            <BasketPanel
              basket={videoBasket}
              title={takesMultiVideo ? 'Video references' : 'Video'}
              cap={takesSingleVideo ? 1 : undefined}
              onInsertToken={(t) => setPromptText((p) => (p && !/\s$/.test(p) ? `${p} ${t}` : p + t))}
            />
          )}

          {multiView && (
            <div className="view-slots">
              <div className="hint">
                Multi-view: assign a board image to each angle of the <em>same object</em>. Front is
                required; back/left/right sharpen the reconstruction. Select an image, then click the
                slot it belongs to.
              </div>
              {viewFields.map((f) => (
                <ViewSlot
                  key={f.name}
                  field={f}
                  assigned={views[f.name] ?? null}
                  candidate={boardSel.image[0] ?? null}
                  onUse={() => {
                    const pick = boardSel.image[0];
                    if (pick) setViews((v) => ({ ...v, [f.name]: { id: pick.id, title: pick.title } }));
                  }}
                  onClear={() =>
                    setViews((v) => {
                      const next = { ...v };
                      delete next[f.name];
                      return next;
                    })
                  }
                />
              ))}
            </div>
          )}

          {referenceField && !imagePrimary && !multiView && refCount > 0 && (
            <div className="ref-hint">
              {refCount} reference image{refCount === 1 ? '' : 's'} connected →{' '}
              {referenceField.multiple ? 'all sent' : 'first sent'} as <code>{referenceField.name}</code>.
            </div>
          )}
          {!referenceField && refCount > 0 && (
            <div className="ref-hint muted">
              This model takes no image input — connected images won’t be sent.
            </div>
          )}

          {hasPromptField && (
            <PromptBasket
              basket={noteBasket}
              text={promptText}
              onTextChange={setPromptText}
              counts={{ Image: imageBasket.items.length, Video: videoBasket.items.length, Audio: 0 }}
            />
          )}

          <SchemaForm
            fields={fields}
            commonOrder={COMMON_ARGS[model.capability]}
            values={values}
            onChange={onChange}
            hide={
              multiView
                ? viewFields.map((f) => f.name)
                : [
                    ...((takesSingle || takesMulti) && referenceField ? [referenceField.name] : []),
                    ...((takesSingleVideo || takesMultiVideo) && videoReferenceField ? [videoReferenceField.name] : []),
                    // The prompt basket owns this field entirely.
                    ...(hasPromptField ? ['prompt'] : []),
                  ]
            }
          />

          {usesImageAgent && hasPromptField && (
            <AssetNaming
              cfg={assetCfg}
              detected={detectedAsset}
              name={assetName}
              edited={assetEdited}
              promptText={promptText}
              onNameChange={(v) => {
                setAssetName(v);
                setAssetEdited(true);
              }}
              onResetName={() => {
                setAssetEdited(false);
                setAssetName(detectedAsset ?? '');
              }}
              onSaveCfg={async (next) => {
                setAssetCfg(next);
                try {
                  await setAssetNamingConfig(next);
                } catch (e) {
                  console.warn('[ImageGenScreen] saving asset-naming config failed', e);
                }
              }}
            />
          )}

          <RequestPreview
            model={model}
            values={values}
            imagePrimary={imagePrimary}
            sourceImage={effectiveSourceImage}
            referenceField={referenceField}
            refCount={refCount}
            videoReferenceField={videoReferenceField}
            sourceVideo={effectiveSourceVideo}
            videoCount={takesMultiVideo ? effectiveSelectedVideos.length : effectiveSourceVideo ? 1 : 0}
            views={multiView ? viewFields.filter((f) => views[f.name]).map((f) => f.label) : null}
            assetName={usesImageAgent && assetName.trim() ? assetName.trim() : null}
          />

          <div className="button-row">
            <button type="button" className="secondary" onClick={onSaveCard}>
              Save as settings card
            </button>
            <button
              type="button"
              className="primary"
              onClick={onGenerate}
              disabled={Boolean(blockReason)}
              title={blockReason ?? undefined}
            >
              {isPanorama
                ? 'Generate panorama'
                : is3d
                  ? 'Generate 3D model'
                  : isVideo
                    ? 'Generate video'
                    : isSegment
                      ? 'Extract object'
                      : 'Generate image'}
            </button>
          </div>
        </>
      )}

      {note && <div className="notice">{note}</div>}
    </div>
  );
}

function ViewSlot({
  field,
  assigned,
  candidate,
  onUse,
  onClear,
}: {
  field: { name: string; label: string; required: boolean };
  assigned: { id: string; title?: string } | null;
  candidate: ImageItem | null;
  onUse: () => void;
  onClear: () => void;
}) {
  // No source row and no pin here, unlike every other media input: a live
  // source can't decide WHICH of four named angles a selection belongs to.
  // These stay deliberate assignment and only borrow the cyan "bound" frame.
  return (
    <div className={`source-image view-slot ${assigned ? 'bound' : ''}`}>
      <div className="view-slot-name">
        {field.label}
        {field.required && ' · required'}
      </div>
      {assigned ? (
        <>
          <div className="view-slot-item">{assigned.title || '(untitled)'}</div>
          <div style={{ display: 'flex', gap: 12 }}>
            <button type="button" className="reset-link" disabled={!candidate} onClick={onUse}>
              Replace
            </button>
            <button type="button" className="reset-link" onClick={onClear}>
              Clear
            </button>
          </div>
        </>
      ) : (
        <button type="button" className="ratio-chip" disabled={!candidate} onClick={onUse}>
          {candidate ? 'Assign selected' : 'Select an image first'}
        </button>
      )}
    </div>
  );
}

/**
 * Asset naming: shows the id auto-detected from the prompt (editable), the name
 * the finished image will get, and a settings disclosure for the extraction
 * regex. Mirrors the Runway "detected asset" UX.
 */
function AssetNaming({
  cfg,
  detected,
  name,
  edited,
  promptText,
  onNameChange,
  onResetName,
  onSaveCfg,
}: {
  cfg: AssetNamingConfig;
  detected: string | null;
  name: string;
  edited: boolean;
  promptText: string;
  onNameChange: (v: string) => void;
  onResetName: () => void;
  onSaveCfg: (next: AssetNamingConfig) => void;
}) {
  // Draft config for the settings form — committed only on Save.
  const [draft, setDraft] = useState<AssetNamingConfig>(cfg);
  useEffect(() => setDraft(cfg), [cfg]);

  const compiled = useMemo(() => compileAssetPattern(draft), [draft]);
  const patternError = 'error' in compiled ? compiled.error : null;
  // Live preview: what the *draft* pattern would pull from the current prompt.
  const draftMatch = useMemo(
    () => extractAssetName(promptText, { ...draft, enabled: true }),
    [promptText, draft],
  );
  const dirty =
    draft.enabled !== cfg.enabled || draft.pattern !== cfg.pattern || draft.flags !== cfg.flags;

  const trimmed = name.trim();

  return (
    <div className="asset-naming">
      <label className="field">
        <span>Asset name</span>
        <input
          type="text"
          value={name}
          placeholder={cfg.enabled ? 'None detected — add one to name the image' : 'Naming off'}
          onChange={(e) => onNameChange(e.target.value)}
        />
      </label>

      {trimmed ? (
        <div className="ref-hint">
          Generated image will be named <code>{trimmed}</code>.
          {!edited && detected && ' Auto-detected from the prompt.'}
        </div>
      ) : (
        <div className="ref-hint muted">
          {cfg.enabled
            ? 'No asset id detected — the image keeps the default name.'
            : 'Auto-naming is off — set a name above or enable it in settings.'}
        </div>
      )}

      {edited && (
        <button type="button" className="reset-link" onClick={onResetName}>
          ↻ Reset to detected{detected ? ` (${detected})` : ''}
        </button>
      )}

      <details className="preview">
        <summary>Naming settings</summary>
        <div className="preview-body">
          <label className="field-row">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(e) => setDraft((d) => ({ ...d, enabled: e.target.checked }))}
            />
            <span>Auto-detect an asset id from the prompt</span>
          </label>

          <label className="field">
            <span>Pattern (regex — capture group 1 is the id)</span>
            <input
              type="text"
              value={draft.pattern}
              spellCheck={false}
              onChange={(e) => setDraft((d) => ({ ...d, pattern: e.target.value }))}
            />
          </label>

          <label className="field">
            <span>Flags</span>
            <input
              type="text"
              value={draft.flags}
              spellCheck={false}
              placeholder="e.g. i"
              onChange={(e) => setDraft((d) => ({ ...d, flags: e.target.value }))}
            />
          </label>

          {patternError ? (
            <div className="ref-hint muted">Invalid regex: {patternError}</div>
          ) : (
            <div className="hint">
              On this prompt →{' '}
              {draftMatch ? <strong>{draftMatch}</strong> : <em>no match</em>}
            </div>
          )}

          <div style={{ display: 'flex', gap: 12 }}>
            <button
              type="button"
              className="reset-link"
              disabled={!dirty || Boolean(patternError)}
              onClick={() => onSaveCfg(draft)}
            >
              Save
            </button>
            <button
              type="button"
              className="reset-link"
              onClick={() => setDraft(DEFAULT_ASSET_NAMING)}
            >
              Reset to default
            </button>
          </div>
        </div>
      </details>
    </div>
  );
}

function RequestPreview({
  model,
  values,
  imagePrimary,
  sourceImage,
  referenceField,
  refCount,
  videoReferenceField,
  sourceVideo,
  videoCount,
  views,
  assetName,
}: {
  model: FalModel;
  values: Record<string, unknown>;
  imagePrimary: boolean;
  sourceImage: ImageItem | null;
  referenceField: { name: string; multiple: boolean; required: boolean } | null;
  refCount: number;
  videoReferenceField: { name: string; multiple: boolean; required: boolean } | null;
  sourceVideo: EmbedItem | null;
  videoCount: number;
  views: string[] | null;
  assetName: string | null;
}) {
  const prompt = typeof values.prompt === 'string' ? values.prompt : '';
  const strength = values.strength;
  const size = values.image_size ?? values.aspect_ratio;
  return (
    <details className="preview">
      <summary>What gets sent</summary>
      <div className="preview-body">
        <div>
          <span className="k">Model</span>
          <span className="v">{model.endpointId}</span>
        </div>
        {assetName && (
          <div>
            <span className="k">Name</span>
            <span className="v">{assetName}</span>
          </div>
        )}
        {views ? (
          <div>
            <span className="k">Views</span>
            <span className="v">{views.length ? views.join(', ') : 'none assigned'}</span>
          </div>
        ) : (
          referenceField && (
            <div>
              <span className="k">Images</span>
              <span className="v">
                {imagePrimary
                  ? sourceImage
                    ? `source${refCount > 1 ? ` + ${refCount - 1} connected` : ''} → ${referenceField.name}`
                    : 'none selected'
                  : refCount > 0
                    ? `${refCount} → ${referenceField.name}`
                    : 'none'}
              </span>
            </div>
          )
        )}
        {videoReferenceField && (
          <div>
            <span className="k">Video</span>
            <span className="v">
              {videoReferenceField.multiple
                ? videoCount > 0
                  ? `${videoCount} → ${videoReferenceField.name}`
                  : 'none'
                : sourceVideo
                  ? `source → ${videoReferenceField.name}`
                  : 'none selected'}
            </span>
          </div>
        )}
        <div>
          <span className="k">Prompt</span>
          <span className="v">{prompt ? truncate(prompt, 120) : '—'}</span>
        </div>
        {size !== undefined && (
          <div>
            <span className="k">Size</span>
            <span className="v">{String(size)}</span>
          </div>
        )}
        {strength !== undefined && (
          <div>
            <span className="k">Strength</span>
            <span className="v">{String(strength)} (low preserves the source)</span>
          </div>
        )}
        {referenceField?.multiple && refCount > 1 && (
          <div className="preview-note">A "Reference image N is NAME." legend is added from connected image names.</div>
        )}
      </div>
    </details>
  );
}

function buildInput(fields: Field[], values: Record<string, unknown>): Record<string, unknown> {
  const jsonFields = new Set(fields.filter((f) => f.kind === 'json').map((f) => f.name));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined || v === null || v === '') continue;
    if (jsonFields.has(k) && typeof v === 'string') {
      try {
        out[k] = JSON.parse(v);
      } catch {
        throw new Error(`"${k}" must be valid JSON.`);
      }
    } else {
      out[k] = v;
    }
  }
  return out;
}

// Returns the explicit ratio the user chose via image_size / aspect_ratio, or
// undefined — in which case the agent falls back to the source image's ratio.
function ratioFromValues(values: Record<string, unknown>): string | undefined {
  const size = values.image_size;
  if (typeof size === 'string' && SIZE_TO_RATIO[size]) return SIZE_TO_RATIO[size];
  const ar = values.aspect_ratio;
  if (typeof ar === 'string' && /^\d+:\d+$/.test(ar)) return ar;
  return undefined;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

