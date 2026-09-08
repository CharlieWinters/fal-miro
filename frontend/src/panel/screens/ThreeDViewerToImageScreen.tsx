import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { proxyUrl, unwrapModel3dEmbedUrl } from '../../lib/api';
import { createImageAtAbsolute, resolveAbsolutePosition } from '../../shared/boardHelpers';
import { ToneIconChip } from '../CapabilityIcon';

type Embed = { id: string; url?: string; width?: number; height?: number };

/** Aspect-ratio choices for the capture (value = width / height; null = original). */
const RATIO_OPTIONS: Array<{ label: string; value: number | null }> = [
  { label: 'Original', value: null },
  { label: '1:1', value: 1 },
  { label: '4:3', value: 4 / 3 },
  { label: '3:4', value: 3 / 4 },
  { label: '16:9', value: 16 / 9 },
  { label: '9:16', value: 9 / 16 },
];

/**
 * 3D Viewer → Image (a "manual operation" from the golden flow).
 *
 * Hosted in the modal iframe so the user gets a large, high-resolution view to
 * orbit and capture from. Given the id of a Fal 3D-viewer embed:
 *
 *   1. Unwrap its underlying .glb and load it into a <model-viewer> (through the
 *      backend CORS proxy so the snapshot canvas isn't tainted).
 *   2. User picks a capture aspect ratio (defaults to the model's original) and
 *      orbits to the angle they want. The viewer is letterboxed to that ratio,
 *      so what they see is exactly what's captured.
 *   3. toDataURL() snapshots the viewer canvas at that ratio (transparent
 *      background) and drops it on the board below the embed.
 */
export function ThreeDViewerToImageScreen({ itemId, onClose }: { itemId: string; onClose: () => void }) {
  const viewerRef = useRef<ModelViewerElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [embed, setEmbed] = useState<Embed | null>(null);
  const [ratio, setRatio] = useState<number | null>(null); // null = original
  const [frame, setFrame] = useState<{ w: number; h: number } | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    void miro.board
      .getById(itemId)
      .then((it) => mounted && setEmbed(it as unknown as Embed))
      .catch(() => mounted && setError('Could not read the selected model.'));
    return () => {
      mounted = false;
    };
  }, [itemId]);

  const glbUrl = useMemo(() => (embed?.url ? unwrapModel3dEmbedUrl(embed.url) : null), [embed]);
  const src = useMemo(() => (glbUrl ? proxyUrl(glbUrl) : null), [glbUrl]);

  // The model's original ratio, from the embed the agent sized to the source image.
  const originalRatio = useMemo(() => {
    if (embed?.width && embed?.height) return embed.width / embed.height;
    return 1;
  }, [embed]);
  const activeRatio = ratio ?? originalRatio;

  // Fit a box of `activeRatio` inside the stage, letterboxed. Recomputed on
  // resize and whenever the chosen ratio changes.
  const recomputeFrame = useCallback(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const cw = stage.clientWidth;
    const ch = stage.clientHeight;
    if (!cw || !ch) return;
    let w = cw;
    let h = cw / activeRatio;
    if (h > ch) {
      h = ch;
      w = ch * activeRatio;
    }
    setFrame({ w: Math.round(w), h: Math.round(h) });
  }, [activeRatio]);

  useEffect(() => {
    recomputeFrame();
    const stage = stageRef.current;
    if (!stage || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(recomputeFrame);
    ro.observe(stage);
    return () => ro.disconnect();
  }, [recomputeFrame, src]); // re-run once the stage mounts (it renders only after src resolves)

  useEffect(() => {
    const el = viewerRef.current;
    if (!el) return;
    const onLoad = () => setReady(true);
    const onErr = () => setError('Could not load the 3D model (proxy may be down).');
    el.addEventListener('load', onLoad);
    el.addEventListener('error', onErr);
    return () => {
      el.removeEventListener('load', onLoad);
      el.removeEventListener('error', onErr);
    };
  }, [src]);

  const handleCapture = async () => {
    const el = viewerRef.current;
    if (!el || !embed) return;
    setBusy(true);
    setError(null);
    setStatus('Capturing view…');
    try {
      const dataUrl = el.toDataURL('image/png');

      const abs = await resolveAbsolutePosition(embed.id);
      if (!abs) throw new Error('Could not resolve the embed position.');
      // Keep the placed image roughly the size of the model on the board; its
      // height follows the captured PNG's (chosen) aspect ratio.
      const width = abs.width || embed.width || 480;
      const height = width / activeRatio;
      const gap = 60;
      const x = abs.absoluteX;
      const y = abs.absoluteY + (abs.height || width) / 2 + gap + height / 2;

      await createImageAtAbsolute({ url: dataUrl, x, y, width, title: 'Fal · 3D view' });
      setStatus('View captured ✓');
      setTimeout(onClose, 700);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const hint = /tainted|insecure|security/i.test(msg)
        ? ' (the CORS proxy may not be running — check the backend)'
        : '';
      setError(`Capture failed: ${msg}${hint}`);
      setStatus(null);
      setBusy(false);
    }
  };

  return (
    <div className="capture">
      <div className="capture-head">
        <button type="button" className="back-link" onClick={onClose} aria-label="Close">
          ← Close
        </button>
        <ToneIconChip capability="model3d" />
        <div>
          <div className="title">3D Viewer → Image</div>
          <div className="sub">Orbit to an angle, then capture it as a board image.</div>
        </div>
      </div>

      {!src ? (
        <div className="capture-stage">
          <div className="empty-state">{error ?? 'Loading the selected 3D model…'}</div>
        </div>
      ) : (
        <>
          <div className="capture-stage" ref={stageRef}>
            {/* Letterboxed frame at the chosen ratio — WYSIWYG for the capture. */}
            <div
              className="capture-frame"
              style={frame ? { width: frame.w, height: frame.h } : { width: '100%', height: '100%' }}
            >
              <model-viewer
                ref={viewerRef}
                src={src}
                camera-controls
                auto-rotate
                shadow-intensity="1"
                exposure="1"
                environment-image="neutral"
                touch-action="pan-y"
              />
            </div>
          </div>

          <div className="capture-controls">
            <div className="capture-ratios">
              <span className="label">Aspect ratio</span>
              {RATIO_OPTIONS.map((opt) => (
                <button
                  key={opt.label}
                  type="button"
                  className={`ratio-chip ${(opt.value ?? null) === ratio ? 'active' : ''}`}
                  onClick={() => setRatio(opt.value)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <div className="hint">
              Drag to orbit, scroll to zoom. The captured PNG matches the framed box (transparent
              background) and lands on the board — ready for Image → Image or Image → Video.
            </div>
            <div className="capture-actions">
              <button className="primary" type="button" disabled={busy || !ready} onClick={handleCapture}>
                {busy ? 'Working…' : ready ? 'Capture view' : 'Loading model…'}
              </button>
              {status && <span className="muted">{status}</span>}
              {error && <span className="error">{error}</span>}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
