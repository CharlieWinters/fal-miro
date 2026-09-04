import { useState } from 'react';
import { startAgentJob } from '../../panel/communication';
import { useFirstSelected, useSelectedItems } from '../../panel/hooks/useSelection';
import { getImageRef } from '../../shared/boardHelpers';
import { appDef } from '.';

type ImageItem = { id: string };
type Slot = { id: string; url: string; title?: string };
type SingleKey = 'sketch' | 'model';

const SINGLE_SLOTS: Array<{ key: SingleKey; label: string; hint: string }> = [
  { key: 'sketch', label: 'Sketch', hint: 'The garment sketch or line drawing.' },
  { key: 'model', label: 'Model', hint: 'The person to fit the finished garment onto.' },
];

/**
 * Flagship "App": sketch + material swatches → a photoreal garment render →
 * fitted onto a model. Two Fal calls chained by the run_pipeline agent
 * (shared/pipelineRunner.ts); this screen only ever collects the fixed
 * inputs and kicks the run off — everything about surviving a closed board,
 * placing each step's output, and advancing to the next step lives in the
 * shared pipeline runner, not here.
 */
export function SketchToTryOnScreen() {
  const selected = useFirstSelected<ImageItem>('image');
  const selectedImages = useSelectedItems<ImageItem>('image');
  const [slots, setSlots] = useState<Partial<Record<SingleKey, Slot>>>({});
  const [materials, setMaterials] = useState<Slot[]>([]);
  const [note, setNote] = useState<string | null>(null);

  const resolveSelected = async (): Promise<Slot | null> => {
    if (!selected) {
      setNote('Select an image on the board first, then click "Use selected image".');
      return null;
    }
    const ref = await getImageRef(selected.id);
    if (!ref) {
      setNote("Couldn't read that image — try a different one.");
      return null;
    }
    setNote(null);
    return { id: ref.miroImageId, url: ref.url, title: ref.title };
  };

  const assignSingle = async (key: SingleKey) => {
    const slot = await resolveSelected();
    if (slot) setSlots((cur) => ({ ...cur, [key]: slot }));
  };

  const addMaterials = async () => {
    if (selectedImages.length === 0) {
      setNote('Select one or more images on the board first, then click "Add selected image(s)".');
      return;
    }
    const refs = await Promise.all(selectedImages.map((s) => getImageRef(s.id)));
    const resolved = refs.filter((r): r is NonNullable<typeof r> => Boolean(r));
    if (resolved.length === 0) {
      setNote("Couldn't read those images — try different ones.");
      return;
    }
    setNote(null);
    setMaterials((cur) => {
      const existingIds = new Set(cur.map((m) => m.id));
      const additions = resolved
        .filter((r) => !existingIds.has(r.miroImageId))
        .map((r) => ({ id: r.miroImageId, url: r.url, title: r.title }));
      return [...cur, ...additions];
    });
  };

  const removeMaterial = (id: string) => {
    setMaterials((cur) => cur.filter((m) => m.id !== id));
  };

  const canRun = Boolean(slots.sketch && materials.length > 0 && slots.model);

  const onRun = () => {
    if (!canRun) {
      setNote('Sketch, at least one material, and a model image are all required.');
      return;
    }
    startAgentJob({
      agentId: 'run_pipeline',
      label: 'Sketch to Try-On',
      kind: 'generic',
      payload: {
        appId: 'sketch-to-tryon',
        // Board item ids, not resolved image data — fixedInputs is persisted
        // to board appData (~30 KB cap) between steps, so anything base64-
        // sized has to be resolved fresh when a step actually needs it (see
        // shared/pipelineAppTypes.ts's resolveImageUrls) rather than carried
        // in here.
        fixedInputs: {
          sketchItemId: slots.sketch!.id,
          materialItemIds: materials.map((m) => m.id),
          modelItemId: slots.model!.id,
        },
      },
    });
    setNote(
      'Started — this runs two model calls in sequence and drops both results on the board as they ' +
        'finish. Safe to close the board; it picks up right where it left off on reopen. Run again ' +
        'anytime with the same or different slots — each run is independent.',
    );
  };

  return (
    <div className="screen">
      <div className="hero">
        <div className="title">Sketch to Try-On</div>
        <div className="sub">
          Sketch + materials → realistic garment → fitted onto a model. Two model calls, one guided flow.
        </div>
      </div>

      <div className="hint" style={{ marginTop: -4 }}>
        Models used:
        <ol style={{ margin: '4px 0 0', paddingLeft: 18 }}>
          {appDef.steps.map((s, i) => (
            <li key={i}>
              {s.label} — <code>{s.endpointId}</code>
            </li>
          ))}
        </ol>
      </div>

      <label className="field">
        <span>Sketch</span>
        <div className={`source-image ${slots.sketch ? 'chosen' : ''}`}>
          {slots.sketch ? (
            <>
              <span className="check">✓</span> {slots.sketch.title || 'Image set'}
            </>
          ) : (
            SINGLE_SLOTS[0].hint
          )}
        </div>
        <button type="button" className="ratio-chip" onClick={() => void assignSingle('sketch')}>
          Use selected image
        </button>
      </label>

      <div className="field">
        <span>Materials</span>
        {materials.length === 0 ? (
          <div className="source-image">A fabric/material swatch — add as many as you need.</div>
        ) : (
          materials.map((m) => (
            <div className="source-image chosen" style={{ display: 'flex', alignItems: 'center', gap: 8 }} key={m.id}>
              <span className="check">✓</span>
              <span style={{ flex: 1 }}>{m.title || 'Image set'}</span>
              <button type="button" className="ratio-chip" onClick={() => removeMaterial(m.id)}>
                Remove
              </button>
            </div>
          ))
        )}
        <button type="button" className="ratio-chip" onClick={() => void addMaterials()}>
          Add selected image{selectedImages.length > 1 ? 's' : ''}
        </button>
      </div>

      <label className="field">
        <span>Model</span>
        <div className={`source-image ${slots.model ? 'chosen' : ''}`}>
          {slots.model ? (
            <>
              <span className="check">✓</span> {slots.model.title || 'Image set'}
            </>
          ) : (
            SINGLE_SLOTS[1].hint
          )}
        </div>
        <button type="button" className="ratio-chip" onClick={() => void assignSingle('model')}>
          Use selected image
        </button>
      </label>

      <button type="button" className="primary" onClick={onRun} disabled={!canRun}>
        Run pipeline
      </button>

      {note && <div className="notice">{note}</div>}
    </div>
  );
}
