import { useEffect, useMemo, useState } from 'react';
import { startAgentJob } from '../communication';
import { SchemaForm } from '../SchemaForm';
import { api } from '../../lib/api';
import { COMMON_ARGS, isBlendReference, type FalModel } from '../../shared/falCatalog';
import { parseFalInputSchema, defaultsFor, pickAudioReferenceField, type Field } from '../../shared/schema';
import { bindSeedanceReferences } from '../../shared/referenceBinding';
import { useBoardReferences, usePromptSource, useSelectionSnapshot } from '../hooks/boardInputs';
import { DrivenPromptField, PromptSourceControl, PromptWaitingHint } from '../PromptSourceControl';
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
  const [pulled, setPulled] = useState<number | null>(null);
  const refs = useBoardReferences();
  // Reference-to-video has no single source image — several references feed
  // it — so 'connected' has nothing to hang off and stays empty here. Off and
  // Selection are the meaningful modes on this screen.
  const sticky = usePromptSource();
  const snapshotSelection = useSelectionSnapshot();
  const [note, setNote] = useState<string | null>(null);

  // A reopened settings card's connected images/videos/audio — fallback
  // source (titles included, so the @Image/@Video/@Audio legend still names
  // them) until the user selects something directly on the board themselves.
  const [seedRefs, setSeedRefs] = useState<{
    images: Array<{ id: string; title?: string }>;
    videos: Array<{ id: string; title?: string }>;
    audios: Array<{ id: string; title?: string }>;
  } | null>(null);
  useEffect(() => {
    if (!seed) return;
    setSeedRefs({ images: seed.images, videos: seed.videos, audios: seed.audios });
  }, [seed?.token]);
  useEffect(() => {
    if (refs.images.length || refs.videos.length || refs.audios.length || sticky.text) setSeedRefs(null);
  }, [refs.images.length, refs.videos.length, refs.audios.length, sticky.text]);

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
  const prompt = typeof values.prompt === 'string' ? values.prompt : '';
  // Schema-driven: only offer/collect audio references for models that
  // actually declare an audio field (e.g. Seedance 2.5's `audio_urls`) —
  // Veo and older Seedance versions don't, so this stays empty for them.
  const audioField = useMemo(() => (blend ? null : pickAudioReferenceField(fields)), [blend, fields]);
  const supportsAudio = Boolean(audioField);

  // Merge a fresh seed's static input over the schema defaults once they're
  // loaded, then apply any connected-sticky field overrides (e.g. a "Prompt:
  // …" or "Duration: 8" sticky) — those win over the frozen input snapshot.
  useEffect(() => {
    if (!seed || schema.status === 'loading') return;
    const overrides = resolveStickyFieldOverrides(seed.stickies, fields);
    setValues((v) => ({ ...v, ...seed.input, ...overrides }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed?.token, schema.status]);

  // Mirror board-driven text into the prompt. Only in a live mode — 'off'
  // never writes here.
  useEffect(() => {
    // `!sticky.text` matters: an empty live mode must not blank the box. The
    // field stays editable while a mode is armed-but-waiting, so clearing it
    // here would delete what the user just typed.
    if (sticky.mode === 'off' || !sticky.text) return;
    setValues((v) => ({ ...v, prompt: sticky.text }));
  }, [sticky.mode, sticky.text]);

  /** Copy the current selection in once, then leave the box alone. */
  const pullOnce = () => {
    const { text, count } = snapshotSelection();
    if (!count) return;
    sticky.setMode('off');
    setValues((v) => ({ ...v, prompt: text }));
    setPulled(count);
  };

  /** Keep the text, hand the box back to the user. */
  const unlink = () => {
    setValues((v) => ({ ...v, prompt: sticky.text }));
    sticky.setMode('off');
    setPulled(null);
  };

  // Enforce the caps (image order == token order for Seedance) — live
  // selection first, falling back to a reopened recipe's connected ids.
  const liveImages = useMemo(() => refs.images.slice(0, maxImages), [refs.images, maxImages]);
  const images = useMemo<Array<{ id: string; title?: string }>>(
    () => (liveImages.length ? liveImages : (seedRefs?.images ?? []).slice(0, maxImages)),
    [liveImages, seedRefs, maxImages],
  );
  // Veo takes no video references.
  const liveVideos = useMemo(
    () => (blend ? [] : refs.videos.slice(0, SEEDANCE_MAX_VIDEOS)),
    [refs.videos, blend],
  );
  const videos = useMemo<Array<{ id: string; title?: string }>>(
    () =>
      blend
        ? []
        : liveVideos.length
          ? liveVideos
          : (seedRefs?.videos ?? []).slice(0, SEEDANCE_MAX_VIDEOS),
    [blend, liveVideos, seedRefs],
  );
  const liveAudios = useMemo(
    () => (supportsAudio ? refs.audios.slice(0, SEEDANCE_MAX_AUDIO) : []),
    [refs.audios, supportsAudio],
  );
  const audios = useMemo<Array<{ id: string; title?: string }>>(
    () =>
      supportsAudio
        ? liveAudios.length
          ? liveAudios
          : (seedRefs?.audios ?? []).slice(0, SEEDANCE_MAX_AUDIO)
        : [],
    [supportsAudio, liveAudios, seedRefs],
  );
  const overflow =
    refs.images.length > maxImages ||
    (!blend && refs.videos.length > SEEDANCE_MAX_VIDEOS) ||
    (supportsAudio && refs.audios.length > SEEDANCE_MAX_AUDIO);

  // The frame the current references came from, if any — live selection
  // (a selected frame, or items inside one) wins; falls back to the reopened
  // card's own frame once its seed refs are in use. Lets the output place
  // below that frame, sized to match, instead of trailing one reference item.
  const usingLiveRefs = liveImages.length > 0 || liveVideos.length > 0 || liveAudios.length > 0;
  const referenceFrameId = usingLiveRefs ? refs.frameId : seed?.frameId ?? undefined;

  // Seedance only: preview the @token mapping + adapted prompt (item ids stand
  // in for urls — the agent re-binds with real urls in the same order).
  const bound = useMemo(
    () =>
      blend
        ? null
        : bindSeedanceReferences({
            prompt,
            images: images.map((i) => ({ url: i.id, title: i.title })),
            videos: videos.map((v) => ({ url: v.id, title: v.title })),
            audios: audios.map((a) => ({ url: a.id, title: a.title })),
          }),
    [blend, prompt, images, videos, audios],
  );
  const titleFor = (id: string) =>
    images.find((i) => i.id === id)?.title ?? videos.find((v) => v.id === id)?.title ?? audios.find((a) => a.id === id)?.title;

  const onGenerate = () => {
    setNote(null);
    if (images.length === 0 && videos.length === 0 && audios.length === 0) {
      setNote(
        blend
          ? 'Select reference images on the board (or a frame containing them).'
          : 'Select reference images/videos/audio on the board (or a frame containing them).',
      );
      return;
    }
    if (!prompt.trim()) {
      setNote(
        blend
          ? 'Describe the shot — the references are blended into it.'
          : 'Describe the shot. Name your references (by their board title) to place them.',
      );
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
    if (sticky.anchorId) connectIds.push(sticky.anchorId);

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

  const total = images.length + videos.length + audios.length;

  return (
    <div className="screen">
      <div className="hero">
        <div className="title">{model.label}</div>
        <div className="sub">{model.endpointId}</div>
      </div>

      {schema.status === 'loading' && <div className="notice">Loading model schema…</div>}

      {schema.status !== 'loading' && (
        <>
          <div className={`source-image ${total ? 'chosen' : ''}`}>
            {total ? (
              blend ? (
                <>
                  <span className="check">✓</span> {images.length} reference image
                  {images.length === 1 ? '' : 's'} → blended into one scene
                </>
              ) : (
                <>
                  <span className="check">✓</span> {images.length} image{images.length === 1 ? '' : 's'}
                  {videos.length ? ` · ${videos.length} video${videos.length === 1 ? '' : 's'}` : ''}
                  {audios.length ? ` · ${audios.length} audio${audios.length === 1 ? '' : ' clips'}` : ''} → sent as
                  {' '}
                  {images.length ? <code>@Image1…{images.length}</code> : null}
                  {videos.length ? (
                    <>
                      {' '}
                      <code>@Video1…{videos.length}</code>
                    </>
                  ) : null}
                  {audios.length ? (
                    <>
                      {' '}
                      <code>@Audio1…{audios.length}</code>
                    </>
                  ) : null}
                </>
              )
            ) : blend ? (
              <>Select reference images on the board — or a frame that contains them.</>
            ) : (
              <>
                Select reference images/videos{supportsAudio ? '/audio' : ''} on the board — or a frame that
                contains them.
              </>
            )}
          </div>

          {overflow && (
            <div className="ref-hint muted">
              {blend
                ? `Veo takes up to ${maxImages} reference images — extra selections are ignored.`
                : `Seedance takes up to ${SEEDANCE_MAX_IMAGES} images, ${SEEDANCE_MAX_VIDEOS} videos${
                    supportsAudio ? `, and ${SEEDANCE_MAX_AUDIO} audio clips` : ''
                  } — extra selections are ignored.`}
            </div>
          )}

          {!blend && bound && total > 0 && (
            <div className="ref-map">
              {bound.image_urls.map((id, i) => (
                <div className="ref-row" key={`img-${id}`}>
                  <code>@Image{i + 1}</code>
                  <span>{titleFor(id) ?? '(untitled — name it on the board)'}</span>
                </div>
              ))}
              {bound.audio_urls.map((id, i) => (
                <div className="ref-row" key={`aud-${id}`}>
                  <code>@Audio{i + 1}</code>
                  <span>{titleFor(id) ?? '(untitled)'}</span>
                </div>
              ))}
              {bound.video_urls.map((id, i) => (
                <div className="ref-row" key={`vid-${id}`}>
                  <code>@Video{i + 1}</code>
                  <span>{titleFor(id) ?? '(untitled)'}</span>
                </div>
              ))}
            </div>
          )}

          {blend && total > 0 && (
            <div className="ref-hint">
              Each image contributes visual cues (subject, palette, lighting, setting); Veo blends
              them — there's no per-image addressing.
            </div>
          )}

          <PromptSourceControl
            mode={sticky.mode}
            onModeChange={(m) => {
              sticky.setMode(m);
              setPulled(null);
            }}
            onPullOnce={pullOnce}
            canPull={snapshotSelection().count > 0}
          />

          {sticky.mode !== 'off' && sticky.isEmpty && <PromptWaitingHint mode={sticky.mode} />}

          {sticky.mode !== 'off' && !sticky.isEmpty && (
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
            commonOrder={COMMON_ARGS.video}
            values={values}
            onChange={(name, value) => {
              if (name === 'prompt') setPulled(null);
              setValues((v) => ({ ...v, [name]: value }));
            }}
            hide={[
              ...(audioField && !REFERENCE_FIELDS.includes(audioField.name)
                ? [...REFERENCE_FIELDS, audioField.name]
                : REFERENCE_FIELDS),
              // A live mode renders the prompt itself, framed and read-only.
              ...(sticky.mode !== 'off' && !sticky.isEmpty ? ['prompt'] : []),
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
            <button type="button" className="primary" onClick={onGenerate}>
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
