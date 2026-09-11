import { useState } from 'react';
import { startAgentJob } from '../communication';
import { useFirstSelected } from '../hooks/useSelection';
import { MAX_AD_SOURCE_PX } from '../../shared/imageResize';
import type { FalModel } from '../../shared/falCatalog';

type ImageItem = { id: string; title?: string };

const TEXT_MODES: Array<{ value: 'font' | 'svg'; label: string; hint: string }> = [
  {
    value: 'font',
    label: 'Live text',
    hint: 'Copy comes back as Miro text you can retype, in the nearest matching board font.',
  },
  {
    value: 'svg',
    label: 'Traced outlines',
    hint: 'Copy comes back as vector images tracing the original letterforms exactly — faithful, but not editable as text.',
  },
];

/**
 * Ad → layers (Bria Ad Delayer).
 *
 * Takes a flat ad image on the board and rebuilds it directly below, at the
 * same size, out of editable board items: the background and product cutouts
 * as images, the copy as Miro text with its colours and sizes, flat fills as
 * shapes.
 */
export function AdLayersScreen({ model }: { model: FalModel }) {
  const selected = useFirstSelected<ImageItem>('image');
  const [textMode, setTextMode] = useState<'font' | 'svg'>('font');
  const [note, setNote] = useState<string | null>(null);

  const blockReason: string | null = !selected ? 'Select the flat ad image on the board first.' : null;

  const onRun = () => {
    setNote(null);
    if (blockReason || !selected) {
      setNote(blockReason);
      return;
    }
    startAgentJob({
      agentId: 'fal_ad_layers',
      label: `${model.label} · layers`,
      kind: 'layers',
      payload: {
        endpointId: model.endpointId,
        sourceImageId: selected.id,
        input: { text_mode: textMode },
      },
    });
    setNote('Splitting the ad — the editable layers will appear below it when they’re ready.');
  };

  return (
    <div className="screen">
      <div className="hero">
        <div className="title">{model.label}</div>
        <div className="sub">{model.endpointId}</div>
      </div>

      <div className={`source-image ${selected ? 'chosen' : ''}`}>
        {selected ? (
          <>
            <span className="check">✓</span> Using selected image
            {selected.title ? <span className="src-title"> · {selected.title}</span> : null}
          </>
        ) : (
          <>Select the flat ad on the board — a finished layout with a product, copy and a logo.</>
        )}
      </div>

      <div className="label">Copy</div>
      <div className="capture-ratios">
        {TEXT_MODES.map((m) => (
          <button
            key={m.value}
            type="button"
            className={`ratio-chip ${textMode === m.value ? 'active' : ''}`}
            onClick={() => setTextMode(m.value)}
          >
            {m.label}
          </button>
        ))}
      </div>
      <div className="hint" style={{ marginTop: -4 }}>
        {TEXT_MODES.find((m) => m.value === textMode)?.hint}
      </div>

      <div className="hint">
        The ad is rebuilt directly below the original at the same size: cutouts as images, copy as text, flat fills
        as shapes, stacked in the model's own order. No frame, so every layer can be dragged or retyped straight
        away. Fonts map to the nearest board font.
      </div>
      <div className="hint">
        This endpoint reads the ad at up to {MAX_AD_SOURCE_PX} px per side, so a larger one is scaled down before
        it is sent. The rebuild still matches the ad's size on the board.
      </div>

      <button
        type="button"
        className="primary"
        onClick={onRun}
        disabled={Boolean(blockReason)}
        title={blockReason ?? undefined}
      >
        Split into layers
      </button>
      {blockReason && <div className="hint">{blockReason}</div>}

      {note && <div className="notice">{note}</div>}
    </div>
  );
}
