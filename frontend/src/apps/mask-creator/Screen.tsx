import { useEffect, useRef, useState } from 'react';
import { api, type StatusResponse } from '../../lib/api';
import { useFirstSelected } from '../../panel/hooks/useSelection';
import { createImageAtAbsolute, getImageRef, resolveAbsolutePosition } from '../../shared/boardHelpers';

type ImageItem = { id: string };
type Point = { x: number; y: number; label: 0 | 1 };

const SAM_ENDPOINT = 'fal-ai/sam-3/image';

/**
 * Create Mask — describe what to segment (SAM) and drop the resulting mask
 * onto the board next to the source. An interactive-tool "app" (see
 * ARCHITECTURE.md's Apps section, Flavor 2), not a pipeline: the SAM call
 * happens directly here rather than through run_pipeline — it's one short
 * call, not a chain, and nothing about an in-progress edit needs to survive
 * a closed board.
 *
 * The text description is required — a mask is only ever created from a
 * described object, never from clicks alone. Clicking a point (shift-click
 * for background) is an optional refinement on top of the description, not
 * a standalone trigger.
 */
export function MaskCreatorScreen() {
  const selected = useFirstSelected<ImageItem>('image');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [itemId, setItemId] = useState<string | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);
  const [points, setPoints] = useState<Point[]>([]);
  const [prompt, setPrompt] = useState('');
  const [maskUrl, setMaskUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const useSelectedImage = async () => {
    if (!selected) {
      setError('Select an image on the board first, then click "Use selected image".');
      return;
    }
    const ref = await getImageRef(selected.id);
    if (!ref) {
      setError("Couldn't read that image — try a different one.");
      return;
    }
    setError(null);
    setPoints([]);
    setMaskUrl(null);
    setItemId(ref.miroImageId);
    setImageUrl(ref.url);
  };

  // Load the source image once it's picked, then redraw (image + point
  // markers) whenever the point list changes.
  useEffect(() => {
    if (!imageUrl) return;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      imgRef.current = img;
      setNaturalSize({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = () => setError('Could not load the selected image (CORS?).');
    img.src = imageUrl;
  }, [imageUrl]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img || !naturalSize) return;
    canvas.width = naturalSize.width;
    canvas.height = naturalSize.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(img, 0, 0, naturalSize.width, naturalSize.height);
    const dotRadius = Math.max(6, naturalSize.width / 150);
    for (const p of points) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, dotRadius, 0, Math.PI * 2);
      ctx.fillStyle = p.label === 1 ? '#4BD1F6' : '#FF5A5A';
      ctx.fill();
      ctx.lineWidth = Math.max(2, naturalSize.width / 400);
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
    }
  }, [naturalSize, points]);

  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || !naturalSize || busy) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = naturalSize.width / rect.width;
    const scaleY = naturalSize.height / rect.height;
    const x = Math.round((e.clientX - rect.left) * scaleX);
    const y = Math.round((e.clientY - rect.top) * scaleY);
    if (x < 0 || y < 0 || x >= naturalSize.width || y >= naturalSize.height) return;
    setMaskUrl(null);
    setPoints((cur) => [...cur, { x, y, label: e.shiftKey ? 0 : 1 }]);
  };

  const clearPoints = () => {
    setPoints([]);
    setMaskUrl(null);
    setError(null);
  };

  const trimmedPrompt = prompt.trim();
  // The description is the required trigger — points only ever refine it.
  const canSegment = Boolean(imageUrl) && trimmedPrompt.length > 0;

  const runSegment = async () => {
    if (!imageUrl || !canSegment) return;
    setBusy(true);
    setError(null);
    setStatus('Segmenting…');
    try {
      const { requestId } = await api.run({
        endpointId: SAM_ENDPOINT,
        input: {
          image_url: imageUrl,
          prompt: trimmedPrompt,
          ...(points.length > 0 ? { point_prompts: points } : {}),
        },
      });
      const final = await pollStatus(requestId, (s) => setStatus(`SAM ${s.status.toLowerCase()}…`));
      const mask = (final.data?.masks as Array<{ url?: string }> | undefined)?.[0]?.url;
      if (!mask) throw new Error('No mask returned');
      setMaskUrl(mask);
      setStatus('Mask ready ✓');
    } catch (e) {
      setError(`Segmentation failed: ${e instanceof Error ? e.message : String(e)}`);
      setStatus(null);
    } finally {
      setBusy(false);
    }
  };

  const saveMask = async () => {
    if (!maskUrl || !itemId) return;
    setBusy(true);
    setError(null);
    try {
      const abs = await resolveAbsolutePosition(itemId);
      const width = abs?.width ?? naturalSize?.width ?? 512;
      const x = abs?.absoluteX ?? 0;
      const y = abs ? abs.absoluteY + abs.height / 2 + 60 + width / 2 : 0;
      await createImageAtAbsolute({ url: maskUrl, x, y, width, title: 'Fal · Mask' });
      setStatus('Mask placed on board ✓');
    } catch (e) {
      setError(`Could not place mask: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="screen">
      <div className="hero">
        <div className="title">Create Mask</div>
        <div className="sub">
          Describe what to segment (SAM) — optionally click a point to refine it, shift-click for background.
        </div>
      </div>

      <label className="field">
        <span>Source image</span>
        <div className={`source-image ${imageUrl ? 'chosen' : ''}`}>
          {imageUrl ? <span className="check">✓ Image set</span> : 'Select an image on the board.'}
        </div>
        <button type="button" className="ratio-chip" onClick={() => void useSelectedImage()}>
          Use selected image
        </button>
      </label>

      {imageUrl && (
        <>
          <canvas
            ref={canvasRef}
            onClick={handleClick}
            style={{ maxWidth: '100%', width: 'auto', height: 'auto', cursor: 'crosshair', borderRadius: 8 }}
          />

          <label className="field">
            <span>Describe what to segment</span>
            <input
              type="text"
              placeholder='e.g. "the red car"'
              value={prompt}
              onChange={(e) => {
                setPrompt(e.target.value);
                setMaskUrl(null);
              }}
              disabled={busy}
            />
          </label>

          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <button type="button" className="reset-link" onClick={clearPoints} disabled={busy || points.length === 0}>
              Clear points
            </button>
            <button type="button" className="primary" onClick={() => void runSegment()} disabled={busy || !canSegment}>
              {busy ? 'Working…' : 'Segment'}
            </button>
            {maskUrl && (
              <button type="button" className="primary" onClick={() => void saveMask()} disabled={busy}>
                Save mask to board
              </button>
            )}
          </div>

          {status && <div className="hint">{status}</div>}
          {error && <div className="notice">{error}</div>}
          {maskUrl && (
            <div className="hint">
              Preview:{' '}
              <img src={maskUrl} alt="Mask preview" style={{ height: 60, verticalAlign: 'middle', borderRadius: 6 }} />
            </div>
          )}
        </>
      )}
    </div>
  );
}

async function pollStatus(
  requestId: string,
  onTick: (s: StatusResponse) => void,
  intervalMs = 2500,
  timeoutMs = 3 * 60 * 1000,
): Promise<StatusResponse> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const s = await api.getStatus(SAM_ENDPOINT, requestId);
    onTick(s);
    if (s.status === 'SUCCEEDED' || s.status === 'FAILED' || s.status === 'UNKNOWN') return s;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Request ${requestId} timed out`);
}
