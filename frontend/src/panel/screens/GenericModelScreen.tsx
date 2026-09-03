import { useEffect, useMemo, useState } from 'react';
import { startAgentJob } from '../communication';
import { SchemaForm } from '../SchemaForm';
import { api, unwrapVideoEmbedUrl } from '../../lib/api';
import { connectItemsToCard, createCardBelow, resolveBoardItems } from '../../shared/boardHelpers';
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
  pickPromptField,
  pickReferenceField,
  pickVideoReferenceField,
  type Field,
} from '../../shared/schema';
import { useBoardReferences, useFirstSelected, usePromptSource, useSelectionSnapshot } from '../hooks/boardInputs';
import { DrivenPromptField, PromptSourceControl, PromptWaitingHint } from '../PromptSourceControl';
import { ModelMetaChips } from '../ModelMetaChips';

type ImageItem = { id: string; title?: string };
type EmbedItem = { id: string; url?: string; title?: string };

type SchemaState =
  | { status: 'loading' }
  | { status: 'ready'; fields: Field[] }
  | { status: 'fallback'; fields: Field[]; error: string };

const PROMPT_FALLBACK: Field[] = [{ name: 'prompt', label: 'Prompt', kind: 'text', required: true }];

/**
 * Catch-all model screen for endpoints without a bespoke screen. Builds its form
 * from the live schema and auto-wires the shared board inputs: the primary image
 * field ← selected image(s), the prompt ← selected stickies. Output (image /
 * video / 3D / link) is placed by the fal_generic agent.
 */
export function GenericModelScreen({ model, seed }: { model: FalModel; seed?: RecipeSeed | null }) {
  const [schema, setSchema] = useState<SchemaState>({ status: 'loading' });
  const [meta, setMeta] = useState<Record<string, unknown> | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [note, setNote] = useState<string | null>(null);

  const sourceImage = useFirstSelected<ImageItem>('image');
  const rawSourceVideo = useFirstSelected<EmbedItem>('embed');
  const boardRefs = useBoardReferences();
  // Prompt autofill is opt-in now — 'off' by default, and only the live modes
  // write into the prompt field. See hooks/boardInputs.ts's usePromptSource.
  const sticky = usePromptSource(sourceImage?.id ?? rawSourceVideo?.id);
  const snapshotSelection = useSelectionSnapshot();
  const [pulled, setPulled] = useState<number | null>(null);

  // A reopened settings card's connected ids — fallback source until the user
  // selects something directly on the board themselves.
  const [seedRefs, setSeedRefs] = useState<{
    images: Array<{ id: string; title?: string }>;
    videos: Array<{ id: string; title?: string }>;
  } | null>(null);
  useEffect(() => {
    if (!seed) return;
    setSeedRefs({ images: seed.images, videos: seed.videos });
  }, [seed?.token]);
  useEffect(() => {
    if (sourceImage || rawSourceVideo || boardRefs.images.length || boardRefs.videos.length || sticky.text) {
      setSeedRefs(null);
    }
  }, [sourceImage, rawSourceVideo, boardRefs.images.length, boardRefs.videos.length, sticky.text]);

  useEffect(() => {
    let mounted = true;
    setSchema({ status: 'loading' });
    setPulled(null);
    api
      .getSchema(model.endpointId)
      .then((res) => {
        if (!mounted) return;
        const fields = parseFalInputSchema(res.openapi);
        setMeta(res.metadata ?? null);
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
        setMeta(null);
        setSchema({ status: 'fallback', fields: PROMPT_FALLBACK, error: String(err?.message ?? err) });
        setValues({});
      });
    return () => {
      mounted = false;
    };
  }, [model.endpointId]);

  const fields = schema.status === 'loading' ? [] : schema.fields;
  const promptField = useMemo(() => pickPromptField(fields), [fields]);
  const referenceField = useMemo(() => pickReferenceField(fields), [fields]);
  const videoReferenceField = useMemo(() => pickVideoReferenceField(fields), [fields]);
  const multiImage = Boolean(referenceField?.multiple);
  const multiVideo = Boolean(videoReferenceField?.multiple);

  // Which board images feed the primary image field — live selection, falling
  // back to a reopened recipe's connected ids.
  const refImageIds = multiImage
    ? boardRefs.images.length
      ? boardRefs.images.map((i) => i.id)
      : seedRefs?.images.map((i) => i.id) ?? []
    : sourceImage
      ? [sourceImage.id]
      : seedRefs?.images[0]
        ? [seedRefs.images[0].id]
        : [];

  // A selected embed only counts as a video candidate when it's a Fal video.
  const sourceVideo = useMemo(
    () => (rawSourceVideo?.url && unwrapVideoEmbedUrl(rawSourceVideo.url) ? rawSourceVideo : null),
    [rawSourceVideo],
  );
  // Which board videos feed the primary video field — same live-first fallback.
  const refVideoIds = multiVideo
    ? boardRefs.videos.length
      ? boardRefs.videos.map((v) => v.id)
      : seedRefs?.videos.map((v) => v.id) ?? []
    : sourceVideo
      ? [sourceVideo.id]
      : seedRefs?.videos[0]
        ? [seedRefs.videos[0].id]
        : [];

  // The frame the current references came from, if any — live selection wins,
  // else falls back to the reopened card's own frame. Lets the output place
  // below that frame, sized to match, instead of trailing one reference item.
  const usingLiveRefs = Boolean(sourceImage || sourceVideo || boardRefs.images.length || boardRefs.videos.length);
  const referenceFrameId = usingLiveRefs ? boardRefs.frameId : seed?.frameId ?? undefined;

  // Merge a fresh seed's static input over the schema defaults once they're
  // loaded, then apply any connected-sticky field overrides (e.g. a "Seed:
  // 42" or "Prompt: …" sticky) — those win over the frozen input snapshot.
  useEffect(() => {
    if (!seed || schema.status === 'loading') return;
    const overrides = resolveStickyFieldOverrides(seed.stickies, fields);
    setValues((v) => ({ ...v, ...seed.input, ...overrides }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed?.token, schema.status]);

  // Mirror the board-driven text into whichever field is this model's primary
  // text field — most models call it `prompt`, a few (mostly TTS) call it
  // `text`. Only runs in a live mode; 'off' never writes here, which is the
  // whole point of the control.
  useEffect(() => {
    // `!sticky.text` matters: an empty live mode must not blank the box. The
    // field stays editable while a mode is armed-but-waiting, so clearing it
    // here would delete what the user just typed.
    if (sticky.mode === 'off' || !promptField || !sticky.text) return;
    const fieldName = promptField.name;
    setValues((v) => ({ ...v, [fieldName]: sticky.text }));
  }, [sticky.mode, sticky.text, promptField]);

  /** Copy the current selection in once, then leave the box alone. */
  const pullOnce = () => {
    if (!promptField) return;
    const { text, count } = snapshotSelection();
    if (!count) return;
    sticky.setMode('off');
    setValues((v) => ({ ...v, [promptField.name]: text }));
    setPulled(count);
  };

  /** Keep the text, hand the box back to the user. */
  const unlink = () => {
    if (promptField) setValues((v) => ({ ...v, [promptField.name]: sticky.text }));
    sticky.setMode('off');
    setPulled(null);
  };

  const onChange = (name: string, value: unknown) => {
    if (name === promptField?.name) {
        setPulled(null);
    }
    setValues((v) => ({ ...v, [name]: value }));
  };

  const onGenerate = () => {
    setNote(null);
    let input: Record<string, unknown>;
    try {
      input = buildInput(fields, values);
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'Invalid input.');
      return;
    }
    if (referenceField?.required && refImageIds.length === 0 && !input[referenceField.name]) {
      setNote(`Select ${multiImage ? 'one or more images' : 'an image'} on the board for this model.`);
      return;
    }
    if (videoReferenceField?.required && refVideoIds.length === 0 && !input[videoReferenceField.name]) {
      setNote(`Select ${multiVideo ? 'one or more Fal videos' : 'a Fal video'} on the board for this model.`);
      return;
    }
    if (promptField?.required && !String(input[promptField.name] ?? '').trim()) {
      setNote(
        sticky.mode === 'off'
          ? 'Type a prompt, or switch Prompt source to Selection to use your sticky notes.'
          : 'Type a prompt or select a sticky note first.',
      );
      return;
    }

    startAgentJob({
      agentId: 'fal_generic',
      label: model.label,
      kind: 'generic',
      payload: {
        endpointId: model.endpointId,
        input,
        stickyId: sticky.anchorId,
        ...(referenceField && refImageIds.length
          ? { imageFields: [{ field: referenceField.name, itemIds: refImageIds, multiple: multiImage }] }
          : {}),
        ...(videoReferenceField && refVideoIds.length
          ? { videoFields: [{ field: videoReferenceField.name, itemIds: refVideoIds, multiple: multiVideo }] }
          : {}),
        ...(seed ? { cardAnchorId: seed.cardId } : {}),
        ...(referenceFrameId ? { referenceFrameId } : {}),
      },
    });
    setNote('Started — watch the board (and the tray above). Result drops in when ready.');
  };

  // Snapshot the model + current inputs as a board Card ("settings card"),
  // connected to whatever fed this screen (images/video/prompt sticky).
  const onSaveCard = async () => {
    setNote(null);
    let input: Record<string, unknown>;
    try {
      input = buildInput(fields, values);
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'Invalid input.');
      return;
    }

    const recipe: RecipeCard = {
      v: RECIPE_CARD_VERSION,
      endpointId: model.endpointId,
      capability: model.capability,
      input,
      referenceField: referenceField ?? null,
      videoReferenceField: videoReferenceField ?? null,
    };

    const connectIds = [...refImageIds, ...refVideoIds];
    if (sticky.anchorId) connectIds.push(sticky.anchorId);

    // A selected frame's contents count as connected too.
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
      console.warn('[GenericModelScreen] frame expansion for save failed', e);
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

      <ModelMetaChips metadata={meta} />

      {schema.status === 'loading' && <div className="notice">Loading model schema…</div>}

      {schema.status !== 'loading' && (
        <>
          {schema.status === 'fallback' && (
            <div className="notice">Couldn’t load the live schema ({schema.error}). Prompt-only form.</div>
          )}

          {referenceField && (
            <div className={`source-image ${refImageIds.length ? 'chosen' : ''}`}>
              {refImageIds.length ? (
                <>
                  <span className="check">✓</span> {refImageIds.length} image{refImageIds.length === 1 ? '' : 's'} →{' '}
                  <code>{referenceField.name}</code>
                </>
              ) : (
                <>
                  Select {multiImage ? 'one or more images' : 'an image'} on the board → <code>{referenceField.name}</code>
                </>
              )}
            </div>
          )}

          {videoReferenceField && (
            <div className={`source-image ${refVideoIds.length ? 'chosen' : ''}`}>
              {refVideoIds.length ? (
                <>
                  <span className="check">✓</span> {refVideoIds.length} video{refVideoIds.length === 1 ? '' : 's'} →{' '}
                  <code>{videoReferenceField.name}</code>
                </>
              ) : (
                <>
                  Select {multiVideo ? 'one or more Fal videos' : 'a Fal video'} on the board →{' '}
                  <code>{videoReferenceField.name}</code>
                </>
              )}
            </div>
          )}

          {promptField && (
            <PromptSourceControl
              mode={sticky.mode}
              onModeChange={(m) => {
                sticky.setMode(m);
                setPulled(null);
              }}
              onPullOnce={pullOnce}
              canPull={snapshotSelection().count > 0}
            />
          )}

          {promptField && sticky.mode !== 'off' && sticky.isEmpty && (
            <PromptWaitingHint mode={sticky.mode} />
          )}

          {promptField && sticky.mode !== 'off' && !sticky.isEmpty && (
            <DrivenPromptField
              mode={sticky.mode}
              text={sticky.text}
              notes={sticky.notes}
              onUnlink={unlink}
            />
          )}

          {pulled !== null && (
            <span className="ps-pulled">
              Pulled {pulled} sticky note{pulled === 1 ? '' : 's'} in. Source stays Off — nothing will overwrite this.
            </span>
          )}

          <SchemaForm
            fields={fields}
            commonOrder={COMMON_ARGS[model.capability] ?? COMMON_ARGS.image}
            values={values}
            onChange={onChange}
            hide={[
              ...(referenceField ? [referenceField.name] : []),
              ...(videoReferenceField ? [videoReferenceField.name] : []),
              // A live mode renders the prompt itself, framed and read-only.
              ...(promptField && sticky.mode !== 'off' && !sticky.isEmpty ? [promptField.name] : []),
            ]}
          />

          <div className="button-row">
            <button type="button" className="secondary" onClick={onSaveCard}>
              Save as settings card
            </button>
            <button type="button" className="primary" onClick={onGenerate}>
              Run model
            </button>
          </div>
        </>
      )}

      {note && <div className="notice">{note}</div>}
    </div>
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
