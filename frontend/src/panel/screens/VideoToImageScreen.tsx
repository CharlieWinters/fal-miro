import { useEffect, useMemo, useRef, useState } from 'react';
import { proxyUrl, unwrapVideoEmbedUrl } from '../../lib/api';
import { createImageAtAbsolute, parseRatio, resolveAbsolutePosition } from '../../shared/boardHelpers';
import { ToneIconChip } from '../CapabilityIcon';

type Embed = { id: string; url?: string; width?: number; height?: number };

/**
 * Video Player → Image (a "manual operation" from the golden flow).
 *
 * Hosted in the modal iframe so the user gets a large view to pick the exact
 * frame. Given the id of a Fal video embed:
 *
 *   1. Unwrap its underlying video URL and load it (through the backend CORS
 *      proxy) into a <video crossorigin="anonymous"> so canvas.toDataURL()
 *      doesn't taint.
 *   2. User scrubs to a frame — or snaps to the last frame, the common case for
 *      continuing a video — and clicks "Capture frame".
 *   3. Draw the current frame to a canvas (at the video's native resolution),
 *      export a PNG, and drop it on the board below the embed.
 */
export function VideoToImageScreen({ itemId, onClose }: { itemId: string; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [embed, setEmbed] = useState<Embed | null>(null);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let mounted = true;
    void miro.board
      .getById(itemId)
      .then((it) => mounted && setEmbed(it as unknown as Embed))
      .catch(() => mounted && setError('Could not read the selected video.'));
    return () => {
      mounted = false;
    };
  }, [itemId]);

  const videoUrl = useMemo(() => (embed?.url ? unwrapVideoEmbedUrl(embed.url) : null), [embed]);
  const src = useMemo(() => (videoUrl ? proxyUrl(videoUrl) : null), [videoUrl]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onTime = () => setCurrentTime(v.currentTime);
    const onMeta = () => setDuration(v.duration || 0);
    v.addEventListener('timeupdate', onTime);
    v.addEventListener('loadedmetadata', onMeta);
    return () => {
      v.removeEventListener('timeupdate', onTime);
      v.removeEventListener('loadedmetadata', onMeta);
    };
  }, [src]);

  const scrub = (t: number) => {
    setCurrentTime(t);
    if (videoRef.current) videoRef.current.currentTime = t;
  };
  const jumpTo = (t: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.pause();
    scrub(t);
  };
  // Step a hair back from the very end — several browsers snap a seek to
  // `duration` past the last keyframe, landing on an empty trailing sample.
  const jumpToLastFrame = () => duration && jumpTo(Math.max(0, duration - 0.04));

  const handleCapture = async () => {
    const video = videoRef.current;
    if (!video || !embed) return;
    setBusy(true);
    setError(null);
    setStatus('Capturing frame…');
    try {
      const targetTime = video.currentTime;
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas 2d context unavailable');
      ctx.drawImage(video, 0, 0);
      // Throws SecurityError here if the video was tainted (not CORS-clean).
      const dataUrl = canvas.toDataURL('image/png');

      const abs = await resolveAbsolutePosition(embed.id);
      if (!abs) throw new Error('Could not resolve the embed position.');
      const { width: imgWidth, height: imgHeight } = parseRatio(
        `${video.videoWidth || 1280}:${video.videoHeight || 720}`,
        720,
      );
      const gap = 60;
      const x = abs.absoluteX;
      const y = abs.absoluteY + (abs.height || imgHeight) / 2 + gap + imgHeight / 2;

      await createImageAtAbsolute({
        url: dataUrl,
        x,
        y,
        width: imgWidth,
        title: `Fal · frame @ ${formatTime(targetTime)}`,
      });
      setStatus(`Frame placed (${formatTime(targetTime)}) ✓`);
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
        <ToneIconChip capability="video" />
        <div>
          <div className="title">Video Player → Image</div>
          <div className="sub">Scrub to a frame, then capture it as a board image.</div>
        </div>
      </div>

      {!src ? (
        <div className="capture-stage">
          <div className="empty-state">{error ?? 'Loading the selected video…'}</div>
        </div>
      ) : (
        <>
          <div className="capture-stage">
            <video ref={videoRef} src={src} controls crossOrigin="anonymous" preload="metadata" playsInline />
          </div>

          <div className="capture-controls">
            <div className="label">
              Time
              <span className="muted" style={{ marginLeft: 8, fontWeight: 400 }}>
                {formatTime(currentTime)} / {formatTime(duration)}
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={duration || 1}
              step={0.01}
              value={currentTime}
              onChange={(e) => scrub(Number(e.target.value))}
              style={{ width: '100%' }}
            />
            <div className="snap-row">
              <button className="reset-link" type="button" onClick={() => jumpTo(0)} disabled={!duration}>
                ⏮ First frame
              </button>
              <button
                className="reset-link"
                type="button"
                onClick={jumpToLastFrame}
                disabled={!duration}
                title="Snap to the last frame — ideal for continuing the next video where this one ends."
              >
                Last frame ⏭
              </button>
            </div>
            <div className="capture-actions">
              <button className="primary" type="button" disabled={busy} onClick={handleCapture}>
                {busy ? 'Working…' : `Capture frame @ ${formatTime(currentTime)}`}
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

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}
