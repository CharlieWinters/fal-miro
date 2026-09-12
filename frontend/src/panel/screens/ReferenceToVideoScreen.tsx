import { useEffect, useMemo, useState } from 'react';
import { startAgentJob } from '../communication';
import { SchemaForm } from '../SchemaForm';
import { api } from '../../lib/api';
import { COMMON_ARGS, isBlendReference, type FalModel } from '../../shared/falCatalog';
import {
  parseFalInputSchema,
  defaultsFor,
  pickAudioReferenceField,
  pickReferenceField,
  pickVideoReferenceField,
  type Field,
} from '../../shared/schema';
import {
  bindVideoReferences,
  videoReferenceCaps,
  videoReferenceDialect,
  videoReferenceToken,
} from '../../shared/referenceBinding';

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

// Caps per endpoint live in shared/referenceBinding.ts (videoReferenceCaps),
// next to the prompt dialects, because both are prose in Fal's schemas rather
// than machine-readable limits.
//
// The fields references flow into are NOT listed here. They used to be —
// ['image_urls', 'video_urls', 'audio_urls'], Seedance's names — which is why
// every model that calls them `reference_image_urls` (MiniMax H3, H3 Max,
// Wan 3.x, Grok) received no references at all and failed with "At least one
// reference image, video, or audio must be provided". They now come from the
// model's own schema via pickReferenceField and its siblings.

// What each dialect's tokens look like, for the preview note only.
const DIALECT_EXAMPLE: Record<string, string> = {
  seedance: '@Image1, @Video1',
  positional: 'Image 1, Video 1',
  character: 'character1',
  bracket: '<IMAGE_0>, counting from zero',
};

const PROMPT_FALLBACK: Field[] = [{ name: 'prompt', label: 'Prompt', kind: 'text', required: true }];

type SchemaState =
  | { status: 'loading' }
  | { status: 'ready'; fields: Field[] }
  | { status: 'fallback'; fields: Field[] };

export function ReferenceToVideoScreen({ model, seed }: { model: FalModel; seed?: RecipeSeed | null }) {
  const blend = isBlendReference(model); // Veo: images-only blend, no @tokens
  const caps = useMemo(() => videoReferenceCaps(model.endpointId), [model.endpointId]);

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
  // Same treatment for images and video clips. Reading these rather than
  // assuming Seedance's names is what makes this screen work for every
  // reference-to-video endpoint instead of just ByteDance's and Kling's.
  const imageRefField = useMemo(() => pickReferenceField(fields), [fields]);
  const videoRefField = useMemo(() => (blend ? null : pickVideoReferenceField(fields)), [blend, fields]);
  const supportsVideoRefs = Boolean(videoRefField);
  // What the generic form must not also render, now that the baskets own them.
  const referenceFieldNames = useMemo(
    () =>
      [imageRefField?.name, videoRefField?.name, audioField?.name].filter(
        (n): n is string => Boolean(n),
      ),
    [imageRefField, videoRefField, audioField],
  );

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
  const images = imageBasket.items.slice(0, caps.images);
  // A model that declares no video field gets no video references, however
  // many are sitting in the basket — Kling, Happy Horse and Grok take images
  // only, and sending clips they never declared is how silent rejections start.
  const videos = supportsVideoRefs ? videoBasket.items.slice(0, caps.videos) : [];
  const audios = supportsAudio ? audioBasket.items.slice(0, caps.audios) : [];
  // Each basket warns about its own overflow, so nothing global is needed here.
  const referenceFrameId = seed?.frameId ?? undefined;

  // Preview the prompt exactly as the agent will send it, for whichever
  // dialect this endpoint speaks (item ids stand in for urls — the agent
  // re-binds with real urls in the same order). Previously this was shown for
  // Seedance only, which meant the models that needed it most — the ones whose
  // dialect nobody could guess — showed nothing.
  const bound = useMemo(
    () =>
      bindVideoReferences({
        endpointId: model.endpointId,
        prompt,
        images: images.map((i) => ({ url: i.id, title: i.label })),
        videos: videos.map((v) => ({ url: v.id, title: v.label })),
        audios: audios.map((a) => ({ url: a.id, title: a.label })),
      }),
    [model.endpointId, prompt, images, videos, audios],
  );
  const dialect = useMemo(() => videoReferenceDialect(model.endpointId), [model.endpointId]);

  /**
   * Why Generate can't run yet, or null — drives both the disabled button and
   * the message. Same shape as the other two screens.
   */
  const blockReason: string | null = (() => {
    // Refuse to submit into a field the model does not have. Without this the
    // panel happily sent references under Seedance's names to models that use
    // different ones, and the only symptom was a rejection from Fal minutes
    // later saying no references had been provided.
    if (schema.status !== 'loading' && referenceFieldNames.length === 0) {
      return 'This model declares no reference field the panel recognises — use the generic model form for it.';
    }
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
    const input = buildInput(fields, values, referenceFieldNames);
    // The prompt basket owns this field: SchemaForm is told to hide it (see
    // `hide` below), so `values` never carries a prompt and buildInput can't
    // find one. Inject the assembled value — notes in basket order, then the
    // typed text — the same way ImageGenScreen and GenericModelScreen do.
    // Without this the agent receives no prompt at all and throws.
    if (prompt.trim()) input.prompt = prompt;
    startAgentJob({
      agentId: 'fal_video_gen',
      label: `${model.label} · video`,
      kind: 'video',
      payload: {
        endpointId: model.endpointId,
        input,
        placeholderRatio: ratioFromValues(values),
        references: {
          imageIds: images.map((i) => i.id),
          ...(supportsVideoRefs ? { videoIds: videos.map((v) => v.id) } : {}),
          ...(supportsAudio ? { audioIds: audios.map((a) => a.id) } : {}),
          ...(blend ? { blend: true } : {}),
          // Resolved from this model's schema, so the agent never has to guess.
          fields: {
            ...(imageRefField ? { image: imageRefField.name } : {}),
            ...(videoRefField ? { video: videoRefField.name } : {}),
            ...(audioField ? { audio: audioField.name } : {}),
          },
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
    const input = buildInput(fields, values, referenceFieldNames);
    // Same reason as onGenerate — the basket owns the prompt, so the card has
    // to record the assembled value or reopening it comes back with none.
    if (prompt.trim()) input.prompt = prompt;

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
            cap={caps.images}
            showTokens={Boolean(videoReferenceToken(dialect, 'image', 0))}
            tokenFor={(i) => videoReferenceToken(dialect, 'image', i) ?? ''}
            onInsertToken={(t) => setPromptText((p) => (p && !/\s$/.test(p) ? `${p} ${t}` : p + t))}
          />

          {supportsVideoRefs && (
            <BasketPanel
              basket={videoBasket}
              title="Video references"
              cap={caps.videos}
              showTokens={Boolean(videoReferenceToken(dialect, 'video', 0))}
              tokenFor={(i) => videoReferenceToken(dialect, 'video', i) ?? ''}
              onInsertToken={(t) => setPromptText((p) => (p && !/\s$/.test(p) ? `${p} ${t}` : p + t))}
            />
          )}

          {supportsAudio && (
            <BasketPanel
              basket={audioBasket}
              title="Audio"
              cap={caps.audios}
              showTokens={Boolean(videoReferenceToken(dialect, 'audio', 0))}
              tokenFor={(i) => videoReferenceToken(dialect, 'audio', i) ?? ''}
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
              ...referenceFieldNames,
              // The prompt basket owns this field.
              'prompt',
            ]}
          />

          {bound && (
            <details className="preview">
              <summary>Prompt sent to {model.label}</summary>
              <div className="preview-body">
                <div>
                  <span className="k">Prompt</span>
                  <span className="v">{bound.prompt.trim() || '—'}</span>
                </div>
                <div className="preview-note">
                  {dialect === 'none' ? (
                    <>
                      This model reads references in basket order and has no way to address them from
                      the prompt, so the prompt is sent exactly as written.
                    </>
                  ) : dialect === 'legend' ? (
                    <>
                      No documented token scheme for this model, so a plain &ldquo;Reference image N is
                      NAME&rdquo; legend is prepended and the prompt is left alone.
                    </>
                  ) : (
                    <>
                      Board titles you mention are rewritten to this model&rsquo;s own reference tokens
                      ({DIALECT_EXAMPLE[dialect]}). Write them yourself to control the order.
                    </>
                  )}
                  {referenceFieldNames.length > 0 && (
                    <> Sent as <code>{referenceFieldNames.join('</code>, <code>')}</code>.</>
                  )}
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

function buildInput(
  fields: Field[],
  values: Record<string, unknown>,
  referenceFieldNames: string[],
): Record<string, unknown> {
  const jsonFields = new Set(fields.filter((f) => f.kind === 'json').map((f) => f.name));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined || v === null || v === '') continue;
    if (referenceFieldNames.includes(k)) continue; // driven by the baskets
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
