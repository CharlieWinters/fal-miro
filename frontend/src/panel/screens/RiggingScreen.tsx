import { useMemo, useState } from 'react';
import { startAgentJob } from '../communication';
import { useFirstSelected } from '../hooks/useSelection';
import { unwrapModel3dEmbedUrl } from '../../lib/api';
import { MESHY_PRESETS } from '../../shared/meshyAnimations';
import type { FalModel } from '../../shared/falCatalog';

type EmbedItem = { id: string; url?: string; title?: string };

// Default animations to generate (walking + running always come free anyway).
const DEFAULT_IDS = [0, 106]; // Idle, Confident Walk

// Remesh polycount presets (Meshy quad remesh, before rigging).
const POLY_PRESETS: Array<{ label: string; value: number }> = [
  { label: '30k', value: 30000 },
  { label: '100k', value: 100000 },
  { label: '200k', value: 200000 },
];

/**
 * Rig + Animate — turn a 3D model already on the board into a rigged, animated
 * character (Meshy). The user selects a Fal 3D viewer as the source and picks
 * which animation presets to generate; walking + running are always included.
 * The result is an animated viewer embed you can pose via "Rig Viewer → Image".
 */
export function RiggingScreen({ model }: { model: FalModel }) {
  const selected = useFirstSelected<EmbedItem>('embed');
  const [ids, setIds] = useState<number[]>(DEFAULT_IDS);
  const [customText, setCustomText] = useState('');
  const [remeshOn, setRemeshOn] = useState(true);
  const [polycount, setPolycount] = useState(100000);
  const [note, setNote] = useState<string | null>(null);

  const modelUrl = useMemo(() => (selected?.url ? unwrapModel3dEmbedUrl(selected.url) : null), [selected]);

  const toggle = (id: number) =>
    setIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  // Parse the custom-IDs field: integers in [0, 696], from the Meshy library.
  const customIds = useMemo(
    () =>
      customText
        .split(/[\s,]+/)
        .map((t) => Number(t))
        .filter((n) => Number.isInteger(n) && n >= 0 && n <= 696),
    [customText],
  );
  // Preset selection + custom IDs, deduped, capped at Meshy's 10-per-rig limit.
  const allIds = useMemo(() => [...new Set([...ids, ...customIds])].slice(0, 10), [ids, customIds]);

  const onRig = () => {
    setNote(null);
    if (!modelUrl || !selected) {
      setNote('Select a Fal 3D model on the board to rig.');
      return;
    }
    if (allIds.length === 0) {
      setNote('Pick at least one animation (walking & running are always included).');
      return;
    }
    startAgentJob({
      agentId: 'fal_rig',
      label: `${model.label}`,
      kind: 'rig',
      payload: {
        endpointId: model.endpointId,
        input: { model_url: modelUrl, animation_action_ids: allIds },
        anchorItemId: selected.id,
        parents: [selected.id],
        ...(remeshOn ? { remesh: { polycount } } : {}),
      },
    });
    setNote(
      remeshOn
        ? 'Cleaning up the mesh, then rigging — this takes a few minutes. An animated character will drop on the board.'
        : 'Rigging started — this takes a few minutes. An animated character will drop on the board.',
    );
  };

  return (
    <div className="screen">
      <div className="hero">
        <div className="title">{model.label}</div>
        <div className="sub">{model.endpointId}</div>
      </div>

      <div className={`source-image ${modelUrl ? 'chosen' : ''}`}>
        {modelUrl ? (
          <>
            <span className="check">✓</span> Using selected 3D model
            {selected?.title ? <span className="src-title"> · {selected.title}</span> : null}
          </>
        ) : (
          <>Select a Fal 3D model on the board (a generated 3D viewer) to rig.</>
        )}
      </div>

      <div className="label">Animations to generate</div>
      <div className="hint" style={{ marginTop: -4 }}>
        Walking &amp; running are always included. Pick any extras (up to 10 total). These become the
        clips you can play &amp; pose in the viewer afterward.{' '}
        <a className="doc-link" href="https://docs.meshy.ai/en/api/animation-library" target="_blank" rel="noreferrer noopener">
          Browse Meshy’s animation library ↗
        </a>
      </div>
      <div className="capture-ratios">
        {MESHY_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            className={`ratio-chip ${ids.includes(p.id) ? 'active' : ''}`}
            onClick={() => toggle(p.id)}
          >
            {p.name}
          </button>
        ))}
      </div>

      <label className="field">
        <span>Custom animation IDs</span>
        <input
          type="text"
          placeholder="e.g. 452, 509 — from the library above"
          value={customText}
          onChange={(e) => setCustomText(e.target.value)}
        />
      </label>
      <div className="hint" style={{ marginTop: -4 }}>
        {allIds.length}/10 selected{customIds.length ? ` · custom: ${customIds.join(', ')}` : ''}. Each
        requested animation is generated for your character (adds a little cost/time).
      </div>

      <div className="label" style={{ marginTop: 4 }}>
        Mesh quality
      </div>
      <div className="capture-ratios">
        <button
          type="button"
          className={`ratio-chip ${remeshOn ? 'active' : ''}`}
          onClick={() => setRemeshOn((v) => !v)}
        >
          {remeshOn ? '✓ ' : ''}Remesh first (better rig)
        </button>
        {remeshOn &&
          POLY_PRESETS.map((p) => (
            <button
              key={p.value}
              type="button"
              className={`ratio-chip ${polycount === p.value ? 'active' : ''}`}
              onClick={() => setPolycount(p.value)}
            >
              {p.label}
            </button>
          ))}
      </div>
      <div className="hint" style={{ marginTop: -4 }}>
        Cleans the raw mesh into quad topology before rigging — Meshy’s recommended flow for cleaner
        deformation. Higher polycount preserves more detail (slower). Adds a small cost.
      </div>

      <button type="button" className="primary" onClick={onRig}>
        Rig + Animate
      </button>

      {note && <div className="notice">{note}</div>}
    </div>
  );
}
