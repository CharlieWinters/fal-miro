import { useEffect, useMemo, useState } from 'react';
import { startAgentJob } from '../communication';
import { SchemaForm } from '../SchemaForm';
import { api } from '../../lib/api';
import { COMMON_ARGS, isBlendReference, type FalModel } from '../../shared/falCatalog';
import { parseFalInputSchema, defaultsFor, pickAudioReferenceField, type Field } from '../../shared/schema';
import { bindSeedanceReferences } from '../../shared/referenceBinding';

import { PromptBasket, assemblePrompt } from '../PromptBasket';
import { BasketPanel } from '../Basket';
import { useBasket } from '../hooks/basket';
import { useBoardSelection } from '../hooks/boardSelection';
import {
  connectItemsToCard,
  createCardBelow,
  createCardInFrame,
  getCommonFrameParent,
} from '../../shared/boardHelpers';
import {
  RECIPE_CARD_VERSION,
  resolveStickyFieldOverrides,
  serializeRecipeCard,
  type RecipeCard,
  type RecipeSeed,
} from '../../shared/recipeCard';

// Caps. Seedance 2.0: up to 9 reference images + 3 video clips (≤12 total).
// Audio cap is a placeholder pending confirmed Seedance 2.5 docs — adjust once
// Fal publishes the real limit.
// Veo blends images only ("ingredients"); its docs show 3.
const SEEDANCE_MAX_IMAGES = 9;
const SEEDANCE_MAX_VIDEOS = 3;
const SEEDANCE_MAX_AUDIO = 3;
const VEO_MAX_IMAGES = 3;

// Array fields the picker drives — hidden from the generic form.
const REFERENCE_FIELDS = ['image_urls', 'video_urls', 'audio_urls'];

const PROMPT_FALLBACK: Field[] = [{ name: 'prompt', label: 'Prompt', kind: 'text', required: true }];

type SchemaState =
  | { status: 'loading' }
  | { status: 'ready'; fields: Field[] }
  | { status: 'fallback'; fields: Field[] };

export function ReferenceToVideoScreen({ model, seed }: { model: FalModel; seed?: RecipeSeed | null }) {
  const blend = isBlendReference(model); // Veo: images-only blend, no @tokens
  const maxImages = blend ? VEO_MAX_IMAGES : SEEDANCE_MAX_IMAGES;

  const [schema, setSchema] = useState<SchemaState>({ status: 'loading' });
  const [values, setValues] = useState<Record<string, unknown>>({});
  const boardSel = useBoardSelection();
  const noteBasket = useBasket('note', boardSel);
  const [promptText, setPromptText] = useState('');
  const fullPrompt = assemblePrompt(noteBasket, promptText);
  const [note, setNote] = useState<string | null>(null);

  // Live schema → drives prompt / duration / resolution / aspect_ratio / audio.
  useEffect(() => {
    let mounted = true;
    setSchema({ status: 'loading' });
    api
      .getSchema(model.endpointId)
      .then((res) => {
        if (!mounted) return;
        const fields = parseFalInputSchema(res.openapi);
        if (fields.length === 0) {
          setSchema({ status: 'fallback', fields: PROMPT_FALLBACK });
          setValues({});
        } else {
          setSchema({ status: 'ready', fields });
          setValues(defaultsFor(fields));
        }
      })
      .catch(() => {
        if (!mounted) return;
        setSchema({ status: 'fallback', fields: PROMPT_FALLBACK });
        setValues({});
      });
    return () => {
      mounted = false;
    };
  }, [model.endpointId]);

  const fields = schema.status === 'loading' ? [] : schema.fields;
  const prompt = fullPrompt;
  // Schema-driven: only offer/collect audio references for models that
  // actually declare an audio field (e.g. Seedance 2.5's `audio_urls`) —
  // Veo and older Seedance versions don't, so this stays empty for them.
  const audioField = useMemo(() => (blend ? null : pickAudioReferenceField(fields)), [blend, fields]);
  const supportsAudio = Boolean(audioField);

  // Merge a fresh seed's static input over the schema defaults once they're
  // loaded, then apply any connected-sticky field overrides (e.g. a "Prompt:
  // …" or "Duration: 8" sticky) — those win over the frozen input snapshot.
  useEffect(() => {
    if (!seed) return;
    imageBasket.replace(seed.images);
    videoBasket.replace(seed.videos);
    audioBasket.replace(seed.audios);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed?.token]);

  useEffect(() => {
    if (!seed || schema.status === 'loading') return;
    const overrides = resolveStickyFieldOverrides(seed.stickies, fields);
    setValues((v) => ({ ...v, ...seed.input, ...overrides }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed?.token, schema.status]);

  // One binding per reference kind. Order is load-bearing here — chip order is
  // token order — so each slot shows its items numbered with the @Image1 /
  // @Video1 / @Audio1 token the prompt will address them by.
  //
  // No connector anchor: this screen has several references and no single
  // subject to hang them off, so 'connected' honestly resolves to nothing
  // rather than guessing which reference is the subject.
  const imageBasket = useBasket('image', boardSel);
  const videoBasket = useBasket('video', boardSel);
  const audioBasket = useBasket('audio', boardSel);

  // Caps are applied here, at send time, rather than by refusing the add — the
  // basket shows everything you put in it and warns when the tail won't fit.
  const images = imageBasket.items.slice(0, maxImages);
  const videos = blend ? [] : videoBasket.items.slice(0, SEEDANCE_MAX_VIDEOS);
  const audios = supportsAudio ? audioBasket.items.slice(0, SEEDANCE_MAX_AUDIO) : [];
  // Each basket warns about its own overflow, so nothing global is needed here.
  const referenceFrameId = seed?.frameId ?? undefined;

  // Seedance only: preview the @token mapping + adapted prompt (item ids stand
  // in for urls — the agent re-binds with real urls in the same order).
  const bound = useMemo(
    () =>
      blend
        ? null
        : bindSeedanceReferences({
            prompt,
            images: images.map((i) => ({ url: i.id, title: i.label })),
            videos: videos.map((v) => ({ url: v.id, title: v.label })),
            audios: audios.map((a) => ({ url: a.id, title: a.label })),
          }),
    [blend, prompt, images, videos, audios],
  );

  /**
   * Why Generate can't run yet, or null — drives both the disabled button and
   * the message. Same shape as the other two screens.
   */
  const blockReason: string | null = (() => {
    if (imageBasket.hasMissing) return 'An image in the basket is no longer on the board — remove it first.';
    if (videoBasket.hasMissing) return 'A video in the basket is no longer on the board — remove it first.';
    if (audioBasket.hasMissing) return 'An audio clip in the basket is no longer on the board — remove it first.';
    if (noteBasket.hasMissing) return 'A sticky note in the prompt is no longer on the board — remove it first.';
    if (images.length === 0 && videos.length === 0 && audios.length === 0) {
      return blend
        ? 'Add reference images to the basket first — select on the board, then press Add.'
        : 'Add references to a basket first — select on the board, then press Add.';
    }
    if (!prompt.trim()) {
      return blend
        ? 'Describe the shot — the references are blended into it.'
        : 'Describe the shot. Name your references (by their board title) to place them.';
    }
    return null;
  })();

  const onGenerate = () => {
    setNote(null);
    if (blockReason) {
      setNote(blockReason);
      return;
    }
    const input = buildInput(fields, values);
    startAgentJob({
      agentId: 'fal_video_gen',
      label: `${model.label} · video`,
      kind: 'video',
      payload: {
        endpointId: model.endpointId,
        input,
        placeholderRatio: ratioFromValues(values),
        references: blend
          ? { imageIds: images.map((i) => i.id), blend: true }
          : {
              imageIds: images.map((i) => i.id),
              videoIds: videos.map((v) => v.id),
              ...(supportsAudio ? { audioIds: audios.map((a) => a.id) } : {}),
            },
        ...(seed ? { cardAnchorId: seed.cardId } : {}),
        ...(referenceFrameId ? { referenceFrameId } : {}),
      },
    });
    setNote('Video generation started — this takes a few minutes. Watch the board (and the tray above).');
  };

  // Snapshot the model + current inputs as a board Card ("settings card"),
  // connected to whatever fed this screen (references + prompt sticky). No
  // single referenceField here — this screen's whole shape is the ordered
  // multi-image/multi-video reference list, resolved fresh on reopen.
  const onSaveCard = async () => {
    setNote(null);
    const input = buildInput(fields, values);

    const recipe: RecipeCard = {
      v: RECIPE_CARD_VERSION,
      endpointId: model.endpointId,
      capability: model.capability,
      input,
      referenceField: null,
      videoReferenceField: null,
    };

    const connectIds = [...images.map((i) => i.id), ...videos.map((v) => v.id), ...audios.map((a) => a.id)];
    connectIds.push(...noteBasket.items.map((n) => n.id));

    try {
      // If every reference already lives in the same frame, drop the card in
      // there too — frame membership is the link, no connectors needed. Only
      // falls back to lines when the references aren't co-located in a frame.
      const frameId = connectIds.length ? await getCommonFrameParent(connectIds) : null;
      const { id: cardId } = frameId
        ? await createCardInFrame({
            frameId,
            title: `Settings · ${model.label}`,
            description: serializeRecipeCard(recipe),
          })
        : await createCardBelow({
            sourceItemId: connectIds[0],
            title: `Settings · ${model.label}`,
            description: serializeRecipeCard(recipe),
          });
      if (!frameId && connectIds.length) await connectItemsToCard(connectIds, cardId);
      setNote(
        frameId
          ? 'Saved as a settings card inside the frame — its references travel with it, no lines needed.'
          : 'Saved as a settings card on the board.',
      );
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
          {/* One row per reference kind. Chip order is token order, so the
              numbered chips ARE the @Image1/@Video1/@Audio1 legend. */}
          {/* Chip order is token order — the numbered rows ARE the
              @Image1/@Video1/@Audio1 legend. */}
          <BasketPanel
            basket={imageBasket}
            title="Image references"
            cap={maxImages}
            showTokens={!blend}
            onInsertToken={(t) => setPromptText((p) => (p && !/\s$/.test(p) ? `${p} ${t}` : p + t))}
          />

          {!blend && (
            <BasketPanel
              basket={videoBasket}
              title="Video references"
              cap={SEEDANCE_MAX_VIDEOS}
              onInsertToken={(t) => setPromptText((p) => (p && !/\s$/.test(p) ? `${p} ${t}` : p + t))}
            />
          )}

          {supportsAudio && (
            <BasketPanel
              basket={audioBasket}
              title="Audio"
              cap={SEEDANCE_MAX_AUDIO}
              onInsertToken={(t) => setPromptText((p) => (p && !/\s$/.test(p) ? `${p} ${t}` : p + t))}
            />
          )}

          <PromptBasket
            basket={noteBasket}
            text={promptText}
            onTextChange={setPromptText}
            counts={{ Image: images.length, Video: videos.length, Audio: audios.length }}
          />

          <SchemaForm
            fields={fields}
            commonOrder={COMMON_ARGS.video}
            values={values}
            onChange={(name, value) => setValues((v) => ({ ...v, [name]: value }))}
            hide={[
              ...(audioField && !REFERENCE_FIELDS.includes(audioField.name)
                ? [...REFERENCE_FIELDS, audioField.name]
                : REFERENCE_FIELDS),
              // The prompt basket owns this field.
              'prompt',
            ]}
          />

          {!blend && bound && (
            <details className="preview">
              <summary>Prompt sent to Seedance</summary>
              <div className="preview-body">
                <div>
                  <span className="k">Prompt</span>
                  <span className="v">{bound.prompt.trim() || '—'}</span>
                </div>
                <div className="preview-note">
                  Board titles you mention are rewritten to @Image/@Video{supportsAudio ? '/@Audio' : ''}{' '}
                  tokens. Write the tokens yourself to control the order.
                </div>
              </div>
            </details>
          )}

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
              Generate video
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
    if (REFERENCE_FIELDS.includes(k)) continue; // driven by the picker
    if (jsonFields.has(k) && typeof v === 'string') {
      try {
        out[k] = JSON.parse(v);
      } catch {
        /* skip invalid json field */
      }
    } else {
      out[k] = v;
    }
  }
  return out;
}

const SIZE_TO_RATIO: Record<string, string> = {
  '21:9': '21:9',
  '16:9': '16:9',
  '4:3': '4:3',
  '1:1': '1:1',
  '3:4': '3:4',
  '9:16': '9:16',
};

/** The chosen aspect_ratio → placeholder ratio, or undefined for "auto". */
function ratioFromValues(values: Record<string, unknown>): string | undefined {
  const ar = values.aspect_ratio;
  if (typeof ar === 'string' && SIZE_TO_RATIO[ar]) return ar;
  return undefined;
}
