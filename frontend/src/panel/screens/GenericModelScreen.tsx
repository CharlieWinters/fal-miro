import { useEffect, useMemo, useState } from 'react';
import { startAgentJob } from '../communication';
import { SchemaForm } from '../SchemaForm';
import { api } from '../../lib/api';
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
import { BasketPanel } from '../Basket';
import { PromptBasket, assemblePrompt } from '../PromptBasket';
import { useBasket } from '../hooks/basket';
import { useBoardSelection } from '../hooks/boardSelection';


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
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [note, setNote] = useState<string | null>(null);

  // Reference baskets — ordered lists the user builds. Nothing mirrors the
  // selection, so clicking around the board costs no SDK calls.
  const boardSel = useBoardSelection();
  const imageBasket = useBasket('image', boardSel);
  const videoBasket = useBasket('video', boardSel);
  const noteBasket = useBasket('note', boardSel);
  const [promptText, setPromptText] = useState('');
  const fullPrompt = assemblePrompt(noteBasket, promptText);

  // Reopening a settings card pre-fills the baskets and stops there — no
  // separate "from this card" state to reason about.
  useEffect(() => {
    if (!seed) return;
    imageBasket.replace(seed.images);
    videoBasket.replace(seed.videos);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed?.token]);

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

  const fields = schema.status === 'loading' ? [] : schema.fields;
  const promptField = useMemo(() => pickPromptField(fields), [fields]);
  const referenceField = useMemo(() => pickReferenceField(fields), [fields]);
  const videoReferenceField = useMemo(() => pickVideoReferenceField(fields), [fields]);
  const multiImage = Boolean(referenceField?.multiple);
  const multiVideo = Boolean(videoReferenceField?.multiple);

  // A single-value field sends the first basket item; the basket shows the rest.
  const refImageIds = (multiImage ? imageBasket.items : imageBasket.items.slice(0, 1)).map((i) => i.id);

  const refVideoIds = (multiVideo ? videoBasket.items : videoBasket.items.slice(0, 1)).map((v) => v.id);

  // The frame the current references came from, if any — live selection wins,
  // else falls back to the reopened card's own frame. Lets the output place
  // below that frame, sized to match, instead of trailing one reference item.
  const referenceFrameId = seed?.frameId ?? undefined;

  // Merge a fresh seed's static input over the schema defaults once they're
  // loaded, then apply any connected-sticky field overrides (e.g. a "Seed:
  // 42" or "Prompt: …" sticky) — those win over the frozen input snapshot.
  useEffect(() => {
    if (!seed || schema.status === 'loading') return;
    const overrides = resolveStickyFieldOverrides(seed.stickies, fields);
    const merged = { ...seed.input, ...overrides } as Record<string, unknown>;
    if (promptField && typeof merged[promptField.name] === 'string') {
      setPromptText(merged[promptField.name] as string);
    }
    setValues((v) => ({ ...v, ...merged }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed?.token, schema.status]);

  const onChange = (name: string, value: unknown) => {
    setValues((v) => ({ ...v, [name]: value }));
  };

  const onGenerate = () => {
    setNote(null);
    let input: Record<string, unknown>;
    try {
      input = buildInput(fields, values);
      // The prompt basket owns this field — SchemaForm no longer writes it.
      if (promptField && fullPrompt.trim()) input[promptField.name] = fullPrompt;
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
      setNote('Type a prompt, or add sticky notes to the prompt basket.');
      return;
    }

    startAgentJob({
      agentId: 'fal_generic',
      label: model.label,
      kind: 'generic',
      payload: {
        endpointId: model.endpointId,
        input,
        stickyId: noteBasket.items[0]?.id,
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
      // The prompt basket owns this field — SchemaForm no longer writes it.
      if (promptField && fullPrompt.trim()) input[promptField.name] = fullPrompt;
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
    connectIds.push(...noteBasket.items.map((n) => n.id));

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


      {schema.status === 'loading' && <div className="notice">Loading model schema…</div>}

      {schema.status !== 'loading' && (
        <>
          {schema.status === 'fallback' && (
            <div className="notice">Couldn’t load the live schema ({schema.error}). Prompt-only form.</div>
          )}

          {referenceField && (
            <BasketPanel
              basket={imageBasket}
              title={multiImage ? 'Image references' : 'Image'}
              cap={multiImage ? undefined : 1}
              onInsertToken={(t) => setPromptText((p) => (p && !/\s$/.test(p) ? `${p} ${t}` : p + t))}
            />
          )}

          {videoReferenceField && (
            <BasketPanel
              basket={videoBasket}
              title={multiVideo ? 'Video references' : 'Video'}
              cap={multiVideo ? undefined : 1}
              onInsertToken={(t) => setPromptText((p) => (p && !/\s$/.test(p) ? `${p} ${t}` : p + t))}
            />
          )}

          {promptField && (
            <PromptBasket
              basket={noteBasket}
              text={promptText}
              onTextChange={setPromptText}
              counts={{ Image: imageBasket.items.length, Video: videoBasket.items.length, Audio: 0 }}
            />
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
              ...(promptField ? [promptField.name] : []),
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
