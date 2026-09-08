import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { proxyUrl, unwrapRigEmbedUrl } from '../../lib/api';
import { createImageAtAbsolute, resolveAbsolutePosition } from '../../shared/boardHelpers';
import { getItemGenerationSettings, type GenSettings } from '../../shared/storage';
import { ToneIconChip } from '../CapabilityIcon';

type Embed = { id: string; url?: string; width?: number; height?: number };
type Clip = { name: string; url: string };

const RATIO_OPTIONS: Array<{ label: string; value: number }> = [
  { label: '3:4', value: 3 / 4 },
  { label: '9:16', value: 9 / 16 },
  { label: '1:1', value: 1 },
  { label: '4:3', value: 4 / 3 },
  { label: '16:9', value: 16 / 9 },
];

/**
 * Rig Viewer → Image (the "manual pose tool" from the golden flow).
 *
 * Given a rigged-character embed, it loads each animation clip into a
 * <model-viewer>, lets the user play/pause and scrub the timeline to land on a
 * pose (e.g. mid-stride of a walk), orbit the camera, pick a framing, and
 * capture that pose as a board image — ready for the scene / Image → Video.
 */
export function RigPoseScreen({ itemId, onClose }: { itemId: string; onClose: () => void }) {
  const viewerRef = useRef<ModelViewerElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [embed, setEmbed] = useState<Embed | null>(null);
  const [clips, setClips] = useState<Clip[]>([]);
  const [clipIdx, setClipIdx] = useState(0);
  const [ratio, setRatio] = useState(3 / 4);
  const [frame, setFrame] = useState<{ w: number; h: number } | null>(null);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(true);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Resolve the embed + its clip list (from metadata; fall back to the embed's own glb).
  useEffect(() => {
    let mounted = true;
    void (async () => {
      try {
        const it = (await miro.board.getById(itemId)) as unknown as Embed;
        if (!mounted) return;
        setEmbed(it);
        const settings = await getItemGenerationSettings<GenSettings>(itemId);
        let list = settings?.animations ?? [];
        if (list.length === 0) {
          const own = it?.url ? unwrapRigEmbedUrl(it.url) : null;
          if (own) list = [{ name: 'Animation', url: own }];
        }
        if (mounted) setClips(list);
      } catch {
        if (mounted) setError('Could not read the selected character.');
      }
    })();
    return () => {
      mounted = false;
    };
  }, [itemId]);

  const src = useMemo(() => {
    const url = clips[clipIdx]?.url;
    return url ? proxyUrl(url) : null;
  }, [clips, clipIdx]);

  const recomputeFrame = useCallback(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const cw = stage.clientWidth;
    const ch = stage.clientHeight;
    if (!cw || !ch) return;
    let w = cw;
    let h = cw / ratio;
    if (h > ch) {
      h = ch;
      w = ch * ratio;
    }
    setFrame({ w: Math.round(w), h: Math.round(h) });
  }, [ratio]);

  useEffect(() => {
    recomputeFrame();
    const stage = stageRef.current;
    if (!stage || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(recomputeFrame);
    ro.observe(stage);
    return () => ro.disconnect();
  }, [recomputeFrame, src]); // re-run once the stage mounts (it renders only after src resolves)

  // Reset per-clip playback state whenever the loaded animation changes.
  useEffect(() => {
    setReady(false);
    setTime(0);
    setDuration(0);
    setPlaying(true);
  }, [src]);

  useEffect(() => {
    const el = viewerRef.current;
    if (!el) return;
    const onLoad = () => {
      setReady(true);
      setDuration(el.duration || 0);
    };
    const onErr = () => setError('Could not load the animation (proxy may be down).');
    el.addEventListener('load', onLoad);
    el.addEventListener('error', onErr);
    return () => {
      el.removeEventListener('load', onLoad);
      el.removeEventListener('error', onErr);
    };
  }, [src]);

  // While playing, mirror the viewer's current time into the scrubber.
  useEffect(() => {
    if (!ready || !playing) return;
    const id = setInterval(() => {
      const el = viewerRef.current;
      if (!el) return;
      setTime(el.currentTime);
      if (!duration && el.duration) setDuration(el.duration);
    }, 120);
    return () => clearInterval(id);
  }, [ready, playing, duration]);

  const togglePlay = () => {
    const el = viewerRef.current;
    if (!el) return;
    if (playing) {
      el.pause();
      setPlaying(false);
    } else {
      el.play();
      setPlaying(true);
    }
  };

  const scrub = (t: number) => {
    const el = viewerRef.current;
    if (!el) return;
    el.pause();
    el.currentTime = t;
    setPlaying(false);
    setTime(t);
  };

  const handleCapture = async () => {
    const el = viewerRef.current;
    if (!el || !embed) return;
    setBusy(true);
    setError(null);
    setStatus('Capturing pose…');
    try {
      const dataUrl = el.toDataURL('image/png');
      const abs = await resolveAbsolutePosition(embed.id);
      if (!abs) throw new Error('Could not resolve the embed position.');
      const width = abs.width || embed.width || 480;
      const height = width / ratio;
      const gap = 60;
      const x = abs.absoluteX;
      const y = abs.absoluteY + (abs.height || width) / 2 + gap + height / 2;
      await createImageAtAbsolute({ url: dataUrl, x, y, width, title: `Fal · ${clips[clipIdx]?.name ?? 'pose'}` });
      setStatus('Pose captured ✓');
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
        <ToneIconChip capability="rig" />
        <div>
          <div className="title">Rig Viewer → Image</div>
          <div className="sub">Play an animation, scrub to a pose, then capture it.</div>
        </div>
      </div>

      {!src ? (
        <div className="capture-stage">
          <div className="empty-state">{error ?? 'Loading the character…'}</div>
        </div>
      ) : (
        <>
          <div className="capture-stage" ref={stageRef}>
            <div
              className="capture-frame"
              style={frame ? { width: frame.w, height: frame.h } : { width: '100%', height: '100%' }}
            >
              <model-viewer
                ref={viewerRef}
                src={src}
                autoplay
                camera-controls
                shadow-intensity="1"
                exposure="1"
                environment-image="neutral"
                touch-action="pan-y"
              />
            </div>
          </div>

          <div className="capture-controls">
            {clips.length > 1 && (
              <div className="capture-ratios">
                <span className="label">Animation</span>
                {clips.map((c, i) => (
                  <button
                    key={c.url}
                    type="button"
                    className={`ratio-chip ${i === clipIdx ? 'active' : ''}`}
                    onClick={() => setClipIdx(i)}
                  >
                    {c.name}
                  </button>
                ))}
              </div>
            )}

            <div className="capture-actions">
              <button type="button" className="reset-link" onClick={togglePlay} disabled={!ready}>
                {playing ? '⏸ Pause' : '▶ Play'}
              </button>
              <input
                type="range"
                min={0}
                max={duration || 1}
                step={0.01}
                value={time}
                onChange={(e) => scrub(Number(e.target.value))}
                style={{ flex: 1 }}
                disabled={!ready || !duration}
              />
            </div>

            <div className="capture-ratios">
              <span className="label">Aspect ratio</span>
              {RATIO_OPTIONS.map((opt) => (
                <button
                  key={opt.label}
                  type="button"
                  className={`ratio-chip ${opt.value === ratio ? 'active' : ''}`}
                  onClick={() => setRatio(opt.value)}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            <div className="hint">
              Drag to orbit. Pause and scrub to land on a pose (e.g. mid-stride), or play to preview.
              The framed pose is captured to the board — ready for the scene / Image → Video.
            </div>

            <div className="capture-actions">
              <button className="primary" type="button" disabled={busy || !ready} onClick={handleCapture}>
                {busy ? 'Working…' : ready ? 'Capture pose' : 'Loading…'}
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
