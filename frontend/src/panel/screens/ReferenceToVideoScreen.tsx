import { useEffect, useMemo, useState } from 'react';
import { startAgentJob } from '../communication';
import { SchemaForm } from '../SchemaForm';
import { api } from '../../lib/api';
import { COMMON_ARGS, isBlendReference, type FalModel } from '../../shared/falCatalog';
import { parseFalInputSchema, defaultsFor, type Field } from '../../shared/schema';
import { bindSeedanceReferences } from '../../shared/referenceBinding';
import { useBoardReferences } from '../hooks/boardInputs';

// Caps. Seedance 2.0: up to 9 reference images + 3 video clips (≤12 total).
// Veo blends images only ("ingredients"); its docs show 3.
const SEEDANCE_MAX_IMAGES = 9;
const SEEDANCE_MAX_VIDEOS = 3;
const VEO_MAX_IMAGES = 3;

// Array fields the picker drives — hidden from the generic form.
const REFERENCE_FIELDS = ['image_urls', 'video_urls', 'audio_urls'];

const PROMPT_FALLBACK: Field[] = [{ name: 'prompt', label: 'Prompt', kind: 'text', required: true }];

type SchemaState =
  | { status: 'loading' }
  | { status: 'ready'; fields: Field[] }
  | { status: 'fallback'; fields: Field[] };

export function ReferenceToVideoScreen({ model }: { model: FalModel }) {
  const blend = isBlendReference(model); // Veo: images-only blend, no @tokens
  const maxImages = blend ? VEO_MAX_IMAGES : SEEDANCE_MAX_IMAGES;

  const [schema, setSchema] = useState<SchemaState>({ status: 'loading' });
  const [values, setValues] = useState<Record<string, unknown>>({});
  const refs = useBoardReferences();
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
  const prompt = typeof values.prompt === 'string' ? values.prompt : '';

  // Enforce the caps (image order == token order for Seedance).
  const images = useMemo(() => refs.images.slice(0, maxImages), [refs.images, maxImages]);
  // Veo takes no video references.
  const videos = useMemo(
    () => (blend ? [] : refs.videos.slice(0, SEEDANCE_MAX_VIDEOS)),
    [refs.videos, blend],
  );
  const overflow = refs.images.length > maxImages || (!blend && refs.videos.length > SEEDANCE_MAX_VIDEOS);

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
          }),
    [blend, prompt, images, videos],
  );
  const titleFor = (id: string) =>
    images.find((i) => i.id === id)?.title ?? videos.find((v) => v.id === id)?.title;

  const onGenerate = () => {
    setNote(null);
    if (images.length === 0 && videos.length === 0) {
      setNote(
        blend
          ? 'Select reference images on the board (or a frame containing them).'
          : 'Select reference images/videos on the board (or a frame containing them).',
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
          : { imageIds: images.map((i) => i.id), videoIds: videos.map((v) => v.id) },
      },
    });
    setNote('Video generation started — this takes a few minutes. Watch the board (and the tray above).');
  };

  const total = images.length + videos.length;

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
                  {videos.length ? ` · ${videos.length} video${videos.length === 1 ? '' : 's'}` : ''} → sent as{' '}
                  {images.length ? <code>@Image1…{images.length}</code> : null}
                  {videos.length ? (
                    <>
                      {' '}
                      <code>@Video1…{videos.length}</code>
                    </>
                  ) : null}
                </>
              )
            ) : blend ? (
              <>Select reference images on the board — or a frame that contains them.</>
            ) : (
              <>Select reference images/videos on the board — or a frame that contains them.</>
            )}
          </div>

          {overflow && (
            <div className="ref-hint muted">
              {blend
                ? `Veo takes up to ${maxImages} reference images — extra selections are ignored.`
                : `Seedance takes up to ${SEEDANCE_MAX_IMAGES} images and ${SEEDANCE_MAX_VIDEOS} videos — extra selections are ignored.`}
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

          <SchemaForm
            fields={fields}
            commonOrder={COMMON_ARGS.video}
            values={values}
            onChange={(name, value) => setValues((v) => ({ ...v, [name]: value }))}
            hide={REFERENCE_FIELDS}
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
                  Board titles you mention are rewritten to @Image/@Video tokens. Write the tokens
                  yourself to control the order.
                </div>
              </div>
            </details>
          )}

          <button type="button" className="primary" onClick={onGenerate}>
            Generate video
          </button>
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
