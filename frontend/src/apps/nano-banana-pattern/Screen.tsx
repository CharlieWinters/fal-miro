import { useState } from 'react';
import { startAgentJob } from '../../panel/communication';
import { useFirstSelected } from '../../panel/hooks/useSelection';
import { getImageRef } from '../../shared/boardHelpers';
import { appDef } from '.';

type ImageItem = { id: string };
type Slot = { id: string; url: string; title?: string };

const ART_STYLES = [
  'Flat mid-century illustration',
  'Minimalist line art',
  'Watercolor',
  'Retro screen print',
  'Bold geometric',
  'Botanical hand-drawn',
];

/** A hex color field — a native swatch + text input, plus a screen-wide
 *  eyedropper on browsers that support it (Chromium; feature-detected). */
function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (hex: string) => void }) {
  const supportsEyeDropper = typeof window !== 'undefined' && 'EyeDropper' in window;

  const pickWithEyeDropper = async () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const EyeDropperCtor = (window as any).EyeDropper;
      const result = await new EyeDropperCtor().open();
      if (result?.sRGBHex) onChange(result.sRGBHex);
    } catch {
      /* user cancelled the pick — leave the value as-is */
    }
  };

  return (
    <label className="field">
      <span>{label}</span>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          style={{ width: 36, height: 32, padding: 0, border: 'none', background: 'none', flex: '0 0 auto' }}
        />
        <input type="text" value={value} onChange={(e) => onChange(e.target.value)} style={{ flex: 1 }} />
        {supportsEyeDropper && (
          <button
            type="button"
            className="ratio-chip"
            onClick={() => void pickWithEyeDropper()}
            title="Pick a color from anywhere on screen"
          >
            Eyedropper
          </button>
        )}
      </div>
    </label>
  );
}

/**
 * Nano Banana Pattern — turn a board image (the motif) into a seamless,
 * tileable vector pattern via fal-ai/nano-banana/edit. One step, but a real
 * image input (not just text), a dropdown, and native color pickers — a
 * different corner of the "app" surface than the other examples.
 */
export function NanoBananaPatternScreen() {
  const selected = useFirstSelected<ImageItem>('image');
  const [motif, setMotif] = useState<Slot | null>(null);
  const [artStyle, setArtStyle] = useState(ART_STYLES[0]);
  const [colorPalette, setColorPalette] = useState('#D97B3F');
  const [backgroundColor, setBackgroundColor] = useState('#F5F0E6');
  // Fal's own default for nano-banana/edit — "1" strictest, "6" least strict.
  const [safetyTolerance, setSafetyTolerance] = useState('4');
  const [note, setNote] = useState<string | null>(null);

  const useSelectedMotif = async () => {
    if (!selected) {
      setNote('Select an image on the board first, then click "Use selected image".');
      return;
    }
    const ref = await getImageRef(selected.id);
    if (!ref) {
      setNote("Couldn't read that image — try a different one.");
      return;
    }
    setNote(null);
    setMotif({ id: ref.miroImageId, url: ref.url, title: ref.title });
  };

  const canRun = Boolean(motif);

  const onRun = () => {
    if (!canRun) {
      setNote('Select a motif image first.');
      return;
    }
    startAgentJob({
      agentId: 'run_pipeline',
      label: 'Nano Banana Pattern',
      kind: 'generic',
      payload: {
        appId: 'nano-banana-pattern',
        fixedInputs: {
          coreMotifItemId: motif!.id,
          artStyle,
          colorPalette,
          backgroundColor,
          safetyTolerance,
        },
      },
    });
    setNote('Started — the pattern will drop onto the board when it finishes.');
  };

  return (
    <div className="screen">
      <div className="hero">
        <div className="title">Nano Banana Pattern</div>
        <div className="sub">Turn a motif image into a seamless, tileable vector pattern.</div>
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
        <span>Core motif</span>
        <div className={`source-image ${motif ? 'chosen' : ''}`}>
          {motif ? (
            <>
              <span className="check">✓</span> {motif.title || 'Image set'}
            </>
          ) : (
            'The image to turn into a pattern motif.'
          )}
        </div>
        <button type="button" className="ratio-chip" onClick={() => void useSelectedMotif()}>
          Use selected image
        </button>
      </label>

      <label className="field">
        <span>Art style</span>
        <select value={artStyle} onChange={(e) => setArtStyle(e.target.value)}>
          {ART_STYLES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>

      <ColorField label="Color palette" value={colorPalette} onChange={setColorPalette} />
      <ColorField label="Background color" value={backgroundColor} onChange={setBackgroundColor} />

      <label className="field">
        <span>Content moderation strictness ({safetyTolerance}/6)</span>
        <input
          type="range"
          min={1}
          max={6}
          step={1}
          value={safetyTolerance}
          onChange={(e) => setSafetyTolerance(e.target.value)}
        />
      </label>
      <div className="hint" style={{ marginTop: -4 }}>
        1 is strictest, 6 is least strict — Fal's own default is 4. Raising this can help with
        false-positive rejections on clearly benign content, but won't necessarily help with
        character-likeness/IP flags (e.g. clip-art resembling a known mascot), which come from the
        underlying model rather than this setting.
      </div>

      <button type="button" className="primary" onClick={onRun} disabled={!canRun}>
        Run pipeline
      </button>

      {note && <div className="notice">{note}</div>}
    </div>
  );
}
