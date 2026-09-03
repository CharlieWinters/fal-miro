import { useState } from 'react';
import { proxyUrl } from '../../lib/api';
import { useFirstSelected } from '../../panel/hooks/useSelection';
import {
  createImageAtAbsolute,
  getImagePixelRef,
  resolveAbsolutePosition,
} from '../../shared/boardHelpers';
import { autoMaskFromFlat, invert } from './autoMask';
import {
  DEFAULT_WHITE_THRESHOLD,
  buildFillLayer,
  buildMaskLayer,
  composite,
  imageDataOf,
  loadPixelImage,
  toPngDataUrl,
  type FillSource,
} from './fill';

type ImageItem = { id: string };
type Slot = { id: string; url: string; title?: string };

const SWATCHES = [
  '#1f2937',
  '#b91c1c',
  '#ea580c',
  '#eab308',
  '#15803d',
  '#0e7490',
  '#3b82f6',
  '#6d28d9',
  '#be185d',
  '#f5f5f4',
];

/**
 * Pattern Fill — colour or pattern a garment flat, entirely in the browser.
 *
 * Ported from the standalone pattern-fill-miro-app. That version needed AWS
 * Bedrock (Nova Canvas `BackgroundRemoval`) for one thing only: the mask. Here
 * the mask comes from the flat's own outline (./autoMask.ts) or from a mask
 * image on the board — so this app runs with no model call, no credits, and
 * no backend configured, which also means it works on the flats the Fashion
 * Sketches library drops.
 */
export function PatternFillScreen() {
  const selected = useFirstSelected<ImageItem>('image');
  const [garment, setGarment] = useState<Slot | null>(null);
  const [pattern, setPattern] = useState<Slot | null>(null);
  const [mask, setMask] = useState<Slot | null>(null);
  const [color, setColor] = useState('#3b82f6');
  const [mode, setMode] = useState<'color' | 'pattern'>('color');
  const [tileSize, setTileSize] = useState(140);
  const [multiply, setMultiply] = useState(true);
  const [removeBackground, setRemoveBackground] = useState(true);
  const [invertMask, setInvertMask] = useState(false);
  const [threshold, setThreshold] = useState(DEFAULT_WHITE_THRESHOLD);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const assign = async (set: (s: Slot) => void) => {
    if (!selected) {
      setError('Select an image on the board first, then click the button again.');
      return;
    }
    // Pixel-safe URL (a data: URI where Miro can give one), not the
    // model-input URL — see getImagePixelRef.
    const ref = await getImagePixelRef(selected.id);
    if (!ref) {
      setError("Couldn't read that image — try a different one.");
      return;
    }
    setError(null);
    set({ id: ref.miroImageId, url: ref.url, title: ref.title });
  };

  /** Build the composite. Returns the PNG data URL, or null on failure. */
  const render = async (): Promise<string | null> => {
    if (!garment) {
      setError('Pick a garment flat first.');
      return null;
    }
    if (mode === 'pattern' && !pattern) {
      setError('Pick a pattern image, or switch to a solid colour.');
      return null;
    }
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const garmentImg = await loadPixelImage(garment.url, proxyUrl);
      const garmentData = imageDataOf(garmentImg);

      let maskData: Uint8ClampedArray;
      if (mask) {
        const maskImg = await loadPixelImage(mask.url, proxyUrl);
        maskData = buildMaskLayer(maskImg, garmentData.width, garmentData.height).data;
      } else {
        const auto = autoMaskFromFlat(garmentData, { whiteThreshold: threshold });
        maskData = auto.mask;
        // A near-empty or near-total mask means the outline leaked (or there
        // was no outline) — say so rather than silently returning a flat that
        // looks untouched or fully painted over.
        if (auto.coverage < 0.01) {
          setNote(
            "The outline didn't enclose anything — the auto mask came back empty. Raise the white " +
              'threshold, or make a mask with Create Mask and load it below.',
          );
        } else if (auto.coverage > 0.97) {
          setNote(
            'The auto mask covered nearly the whole image — this flat may not have a white ' +
              'background. Try lowering the white threshold.',
          );
        }
      }
      if (invertMask) maskData = invert(maskData);

      const patternImg =
        mode === 'pattern' && pattern ? await loadPixelImage(pattern.url, proxyUrl) : null;
      const fill: FillSource =
        mode === 'pattern' && pattern
          ? { kind: 'pattern', url: pattern.url, tileSize }
          : { kind: 'color', color };

      const fillLayer = buildFillLayer(fill, patternImg, garmentData.width, garmentData.height);
      const result = composite(garmentData, fillLayer, maskData, {
        multiply,
        removeBackground,
        whiteThreshold: threshold,
      });
      return toPngDataUrl(result);
    } catch (e) {
      console.warn('[pattern-fill] render failed', e);
      setError(e instanceof Error ? e.message : 'Could not build the fill.');
      return null;
    } finally {
      setBusy(false);
    }
  };

  const onPreview = async () => {
    const url = await render();
    if (url) setPreview(url);
  };

  /** Place the composite to the right of the garment it came from. */
  const onPlace = async () => {
    const url = preview ?? (await render());
    if (!url || !garment) return;
    setPreview(url);
    try {
      const src = await resolveAbsolutePosition(garment.id);
      const width = src?.width ?? 420;
      const x = src ? src.absoluteX + src.width + 60 : 0;
      const y = src ? src.absoluteY : 0;
      await createImageAtAbsolute({
        url,
        x,
        y,
        width,
        title: `${garment.title ?? 'Garment'} · ${mode === 'color' ? color : 'pattern'}`,
      });
      setNote('Placed next to the garment.');
    } catch (e) {
      console.warn('[pattern-fill] placing failed', e);
      setError(e instanceof Error ? e.message : 'Could not place the result.');
    }
  };

  const slotRow = (label: string, hint: string, slot: Slot | null, set: (s: Slot) => void, clear?: () => void) => (
    <div className="field">
      <span>{label}</span>
      <div className={`source-image ${slot ? 'chosen' : ''}`}>
        {slot ? (
          <>
            <span className="check">✓</span> {slot.title || 'Image set'}
          </>
        ) : (
          hint
        )}
      </div>
      <div className="chip-row">
        <button type="button" className="ratio-chip" onClick={() => void assign(set)}>
          Use selected image
        </button>
        {slot && clear && (
          <button type="button" className="ratio-chip" onClick={clear}>
            Clear
          </button>
        )}
      </div>
    </div>
  );

  return (
    <div className="screen">
      <div className="hero">
        <div className="title">Pattern Fill</div>
        <div className="sub">
          Colour or pattern a garment flat. Runs entirely in your browser — no model call, no
          credits.
        </div>
      </div>

      {slotRow('Garment flat', 'The line drawing to fill — any flat or sketch image on the board.', garment, setGarment)}

      <div className="field">
        <span>Fill with</span>
        <div className="chip-row">
          <button
            type="button"
            className={`ratio-chip ${mode === 'color' ? 'active' : ''}`}
            onClick={() => setMode('color')}
          >
            Colour
          </button>
          <button
            type="button"
            className={`ratio-chip ${mode === 'pattern' ? 'active' : ''}`}
            onClick={() => setMode('pattern')}
          >
            Pattern
          </button>
        </div>
      </div>

      {mode === 'color' ? (
        <div className="field">
          <span>Colour</span>
          <div className="chip-row">
            {SWATCHES.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={c}
                onClick={() => setColor(c)}
                className="pf-swatch"
                style={{
                  background: c,
                  outline: color === c ? '2px solid var(--accent)' : '1px solid var(--border-strong)',
                }}
              />
            ))}
          </div>
          <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
        </div>
      ) : (
        <>
          {slotRow('Pattern', 'The swatch to tile across the garment.', pattern, setPattern)}
          <label className="field">
            <span>Tile size · {tileSize}px</span>
            <input
              type="range"
              min={20}
              max={600}
              step={10}
              value={tileSize}
              onChange={(e) => setTileSize(Number(e.target.value))}
            />
          </label>
        </>
      )}

      <div className="field">
        <span>Mask</span>
        <div className="hint">
          {mask
            ? 'Using the mask image below.'
            : "Auto: the flat's own outline decides where the fill lands. Load a mask (e.g. from Create Mask) if the outline doesn't close."}
        </div>
        {slotRow('Mask image (optional)', 'White = fill here, black = leave alone.', mask, setMask, () =>
          setMask(null),
        )}
      </div>

      <div className="field">
        <span>Options</span>
        <label className="pf-check">
          <input type="checkbox" checked={multiply} onChange={(e) => setMultiply(e.target.checked)} />
          Keep lines &amp; shading (multiply)
        </label>
        <label className="pf-check">
          <input
            type="checkbox"
            checked={removeBackground}
            onChange={(e) => setRemoveBackground(e.target.checked)}
          />
          Drop the white background
        </label>
        <label className="pf-check">
          <input type="checkbox" checked={invertMask} onChange={(e) => setInvertMask(e.target.checked)} />
          Invert the mask
        </label>
      </div>

      <label className="field">
        <span>White threshold · {threshold}</span>
        <input
          type="range"
          min={180}
          max={254}
          value={threshold}
          onChange={(e) => setThreshold(Number(e.target.value))}
        />
        <div className="hint">
          What counts as background. Lower it if the fill bleeds into pale shading; raise it if pale
          areas refuse to fill.
        </div>
      </label>

      {preview && (
        <div className="field">
          <span>Preview</span>
          <div className="pf-preview">
            <img src={preview} alt="Pattern fill preview" />
          </div>
        </div>
      )}

      <div className="chip-row">
        <button type="button" className="ratio-chip" onClick={() => void onPreview()} disabled={busy}>
          {busy ? 'Rendering…' : 'Preview'}
        </button>
        <button type="button" className="primary" onClick={() => void onPlace()} disabled={busy || !garment}>
          Place on board
        </button>
      </div>

      {note && !error && <div className="notice">{note}</div>}
      {error && <div className="error">{error}</div>}
    </div>
  );
}
