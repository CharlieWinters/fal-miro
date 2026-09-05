import { useRef, useState } from 'react';
import { videoEmbedUrl } from '../../lib/api';
import { createEmbedAtPosition } from '../../shared/boardHelpers';
import {
  LONG_CLIP_SECONDS,
  archiveMetadataUrl,
  containerWarning,
  embedBox,
  formatBytes,
  formatDuration,
  parseVideoInput,
  pickArchiveVideo,
  type ArchiveMetadata,
} from './videoUrl';

type Resolved = {
  /** The playable video URL — what goes to Fal as `video_url`. */
  url: string;
  /** Where it came from, for the confirmation line. */
  origin: 'direct' | 'archive.org';
  bytes: number | null;
  format: string | null;
};

type Probe = { duration: number; width: number; height: number };

/**
 * Add Video from URL — put an existing video on the board as one of our video
 * embeds, so every screen that consumes board video (Sound, Merge Videos,
 * Merge Audio + Video, Video → Image) can use it as input.
 *
 * A Flavor-3 app (see ARCHITECTURE.md): no model call, no credits, and it
 * works with no backend configured. It exists because Miro has no video
 * upload — not in the Web SDK and not in the REST API — so the only way video
 * reaches a board is the embed + player-page trick this app reuses from
 * generated output. Nothing downstream can tell the difference: the embed URL
 * is built by the same `videoEmbedUrl()` a finished generation uses, so
 * `unwrapVideoEmbedUrl()` reads it straight back out.
 *
 * The video is referenced, never copied — we hold a URL, so whatever hosts it
 * has to keep serving it, and it must be reachable from both the viewer's
 * browser (to play) and Fal's servers (to read).
 */
export function AddVideoFromUrlScreen() {
  const [input, setInput] = useState('');
  const [resolved, setResolved] = useState<Resolved | null>(null);
  const [probe, setProbe] = useState<Probe | null>(null);
  const [probeFailed, setProbeFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  const reset = () => {
    setResolved(null);
    setProbe(null);
    setProbeFailed(false);
    setError(null);
    setNote(null);
  };

  const check = async () => {
    reset();
    const parsed = parseVideoInput(input);
    if (parsed.kind === 'error') {
      setError(parsed.message);
      return;
    }
    if (parsed.kind === 'direct') {
      setResolved({ url: parsed.url, origin: 'direct', bytes: null, format: null });
      return;
    }

    // archive.org item: the details URL is an HTML page, so ask the item's
    // metadata which file is actually playable.
    setBusy(true);
    try {
      const res = await fetch(archiveMetadataUrl(parsed.identifier));
      if (!res.ok) {
        setError(`archive.org returned ${res.status} for that item.`);
        return;
      }
      const meta = (await res.json()) as ArchiveMetadata;
      const pick = pickArchiveVideo(parsed.identifier, meta);
      if ('error' in pick) {
        setError(pick.error);
        return;
      }
      setResolved({ url: pick.url, origin: 'archive.org', bytes: pick.bytes, format: pick.format });
    } catch (e) {
      setError(`Couldn’t read that archive.org item: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const addToBoard = async () => {
    if (!resolved) return;
    setAdding(true);
    setError(null);
    try {
      const { width, height } = embedBox(probe?.width ?? 0, probe?.height ?? 0);
      const vp = await miro.board.viewport.get();
      await createEmbedAtPosition({
        url: videoEmbedUrl(resolved.url),
        x: vp.x + vp.width / 2,
        y: vp.y + vp.height / 2,
        width,
        height,
      });
      setNote(
        'Added to the board. Select it, then open Sound, Merge Videos, Merge Audio + Video or ' +
          'Video → Image to use it as input.',
      );
    } catch (e) {
      setError(`Couldn’t add the embed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setAdding(false);
    }
  };

  const container = resolved ? containerWarning(resolved.url) : null;
  const tooLong = probe !== null && Number.isFinite(probe.duration) && probe.duration > LONG_CLIP_SECONDS;
  const size = formatBytes(resolved?.bytes ?? null);

  return (
    <div className="screen">
      <div className="hero">
        <div className="title">Add Video from URL</div>
        <div className="sub">no model · no credits</div>
      </div>

      <div className="notice">
        Puts an existing video on the board as a Fal video embed, so the video screens can take it
        as input. Paste a direct video URL, or an archive.org item page — the video stays where
        it’s hosted, so that host has to be reachable by both your browser and Fal.
      </div>

      <label className="field">
        <span>Video or archive.org URL</span>
        <input
          type="url"
          placeholder="https://…/clip.mp4"
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            if (resolved || error) reset();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void check();
          }}
        />
      </label>

      <button type="button" className="secondary" disabled={busy || !input.trim()} onClick={() => void check()}>
        {busy ? 'Resolving…' : 'Check URL'}
      </button>

      {error && <div className="error">{error}</div>}

      {resolved && (
        <>
          <div className={`source-image ${probe && !probeFailed ? 'chosen' : ''}`}>
            <video
              ref={videoRef}
              src={resolved.url}
              controls
              muted
              playsInline
              preload="metadata"
              style={{ width: '100%', display: 'block', background: '#000' }}
              onLoadedMetadata={() => {
                const v = videoRef.current;
                if (!v) return;
                setProbeFailed(false);
                setProbe({ duration: v.duration, width: v.videoWidth, height: v.videoHeight });
              }}
              onError={() => {
                setProbe(null);
                setProbeFailed(true);
              }}
            />
          </div>

          <div className="hint">
            {resolved.origin === 'archive.org' && <div>Resolved from archive.org{resolved.format ? ` · ${resolved.format}` : ''}</div>}
            {probe && (
              <div>
                {formatDuration(probe.duration)}
                {probe.width > 0 ? ` · ${probe.width}×${probe.height}` : ''}
                {size ? ` · ${size}` : ''}
              </div>
            )}
            {!probe && !probeFailed && <div>Reading the video…</div>}
          </div>

          {probeFailed && (
            <div className="notice">
              Your browser couldn’t play that URL, so the board embed probably won’t either. It may
              still work as a model input if Fal can read it — check the link opens on its own
              first.
            </div>
          )}

          {container && <div className="notice">{container}</div>}

          {tooLong && (
            <div className="notice">
              {formatDuration(probe.duration)} is longer than most Fal video-input models accept —
              expect to trim it before using it as one. Frame capture (Video → Image) is fine at
              any length.
            </div>
          )}

          <button type="button" className="primary" disabled={adding} onClick={() => void addToBoard()}>
            {adding ? 'Adding…' : 'Add to board'}
          </button>
        </>
      )}

      {note && <div className="notice">{note}</div>}
    </div>
  );
}
