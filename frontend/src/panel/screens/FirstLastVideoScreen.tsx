import { useEffect, useMemo, useState } from 'react';
import { startAgentJob } from '../communication';
import { useFirstSelected } from '../hooks/useSelection';
import { SchemaForm } from '../SchemaForm';
import { api } from '../../lib/api';
import { COMMON_ARGS, type FalModel } from '../../shared/falCatalog';
import { parseFalInputSchema, defaultsFor, pickFrameFields, type Field } from '../../shared/schema';

type ImageItem = { id: string; title?: string };
type Slot = { id: string; title?: string } | null;

type SchemaState =
  | { status: 'loading' }
  | { status: 'ready'; fields: Field[] }
  | { status: 'fallback'; fields: Field[] };

// Sensible defaults if the schema can't be read.
const FALLBACK_FRAME_FIELDS = { first: 'first_frame_url', last: 'last_frame_url' };

/**
 * Veo first-last-frame: pick two board images (first & last frame) and Veo
 * generates the transition between them. Each slot is filled from the current
 * board selection.
 */
export function FirstLastVideoScreen({ model }: { model: FalModel }) {
  const selected = useFirstSelected<ImageItem>('image');
  const [schema, setSchema] = useState<SchemaState>({ status: 'loading' });
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [first, setFirst] = useState<Slot>(null);
  const [last, setLast] = useState<Slot>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    setSchema({ status: 'loading' });
    api
      .getSchema(model.endpointId)
      .then((res) => {
        if (!mounted) return;
        const fields = parseFalInputSchema(res.openapi);
        setSchema(fields.length ? { status: 'ready', fields } : { status: 'fallback', fields: [] });
        setValues(defaultsFor(fields));
      })
      .catch(() => mounted && setSchema({ status: 'fallback', fields: [] }));
    return () => {
      mounted = false;
    };
  }, [model.endpointId]);

  const fields = schema.status === 'loading' ? [] : schema.fields;
  const frameFields = useMemo(() => pickFrameFields(fields) ?? FALLBACK_FRAME_FIELDS, [fields]);

  const onGenerate = () => {
    setNote(null);
    if (!first || !last) {
      setNote('Set both a first frame and a last frame from the board.');
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
        frames: {
          firstImageId: first.id,
          lastImageId: last.id,
          firstField: frameFields.first,
          lastField: frameFields.last,
        },
      },
    });
    setNote('Video generation started — this takes a few minutes. Watch the board (and the tray above).');
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
          <FrameSlot label="First frame" slot={first} selected={selected} onSet={setFirst} />
          <FrameSlot label="Last frame" slot={last} selected={selected} onSet={setLast} />

          <SchemaForm
            fields={fields}
            commonOrder={COMMON_ARGS.video}
            values={values}
            onChange={(name, value) => setValues((v) => ({ ...v, [name]: value }))}
            hide={[frameFields.first, frameFields.last]}
          />

          <button
            type="button"
            className="primary"
            onClick={onGenerate}
            disabled={!first || !last}
            title={!first || !last ? 'Set both a first frame and a last frame from the board.' : undefined}
          >
            Generate video
          </button>
          {(!first || !last) && (
            <div className="hint">Set both a first frame and a last frame from the board.</div>
          )}
        </>
      )}

      {note && <div className="notice">{note}</div>}
    </div>
  );
}

function FrameSlot({
  label,
  slot,
  selected,
  onSet,
}: {
  label: string;
  slot: Slot;
  selected: ImageItem | null;
  onSet: (s: Slot) => void;
}) {
  return (
    <div className={`source-image ${slot ? 'chosen' : ''}`}>
      <div style={{ marginBottom: 6 }}>
        <strong>{label}</strong>
        {slot ? (
          <>
            : <span className="check">✓</span>
            {slot.title ? <span className="src-title"> {slot.title}</span> : ' set'}
          </>
        ) : (
          ': not set'
        )}
      </div>
      <button
        type="button"
        className="reset-link"
        disabled={!selected}
        onClick={() => selected && onSet({ id: selected.id, title: selected.title })}
      >
        {selected ? 'Use selected image' : 'Select an image on the board'}
      </button>
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
        /* skip invalid json field */
      }
    } else {
      out[k] = v;
    }
  }
  return out;
}
