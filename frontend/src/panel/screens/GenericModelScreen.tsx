import { useEffect, useMemo, useState } from 'react';
import { startAgentJob } from '../communication';
import { SchemaForm } from '../SchemaForm';
import { api } from '../../lib/api';
import { COMMON_ARGS, type FalModel } from '../../shared/falCatalog';
import { parseFalInputSchema, defaultsFor, pickReferenceField, type Field } from '../../shared/schema';
import { useBoardReferences, useFirstSelected, useSelectedStickyText } from '../hooks/boardInputs';
import { ModelMetaChips } from '../ModelMetaChips';

type ImageItem = { id: string; title?: string };

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
export function GenericModelScreen({ model }: { model: FalModel }) {
  const [schema, setSchema] = useState<SchemaState>({ status: 'loading' });
  const [meta, setMeta] = useState<Record<string, unknown> | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [editedPrompt, setEditedPrompt] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const sourceImage = useFirstSelected<ImageItem>('image');
  const boardRefs = useBoardReferences();
  const sticky = useSelectedStickyText();

  useEffect(() => {
    let mounted = true;
    setSchema({ status: 'loading' });
    setEditedPrompt(false);
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
  const promptField = useMemo(() => fields.find((f) => f.name === 'prompt'), [fields]);
  const referenceField = useMemo(() => pickReferenceField(fields), [fields]);
  const multiImage = Boolean(referenceField?.multiple);

  // Which board images feed the primary image field.
  const refImageIds = multiImage
    ? boardRefs.images.map((i) => i.id)
    : sourceImage
      ? [sourceImage.id]
      : [];

  // Seed the prompt from selected stickies until the user edits it.
  useEffect(() => {
    if (editedPrompt || !promptField) return;
    if (sticky.text) setValues((v) => ({ ...v, prompt: sticky.text }));
  }, [sticky.text, editedPrompt, promptField]);

  const onChange = (name: string, value: unknown) => {
    if (name === 'prompt') setEditedPrompt(true);
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
    if (promptField?.required && !String(input.prompt ?? '').trim()) {
      setNote('Type a prompt or select a sticky note first.');
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
      },
    });
    setNote('Started — watch the board (and the tray above). Result drops in when ready.');
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

          <SchemaForm
            fields={fields}
            commonOrder={COMMON_ARGS[model.capability] ?? COMMON_ARGS.image}
            values={values}
            onChange={onChange}
            hide={referenceField ? [referenceField.name] : []}
          />

          {promptField && editedPrompt && (
            <button
              type="button"
              className="reset-link"
              onClick={() => {
                setEditedPrompt(false);
                setNote(null);
              }}
            >
              ↻ Reset prompt to sticky
            </button>
          )}

          <button type="button" className="primary" onClick={onGenerate}>
            Run model
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
