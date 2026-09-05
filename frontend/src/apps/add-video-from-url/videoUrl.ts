// "Add video from URL" — input parsing and Archive.org resolution, kept out of
// Screen.tsx so the rules worth arguing about (what counts as a usable video
// URL, how an archive.org *page* URL becomes a playable *file* URL) are
// testable without a board, an iframe, or a network.
//
// The embed-video.html unwrap below duplicates lib/api.ts's
// unwrapVideoEmbedUrl rather than importing it: that one resolves against
// window.location.origin, and this module deliberately has no DOM. Per
// CONTRIBUTING.md's "duplicate behaviour, share contracts", the copy is the
// point — the shape of our own player URL is the contract, and it lives in
// api.ts.

/**
 * Containers a browser `<video>` can be expected to play. Advisory only: a URL
 * with no extension at all is perfectly normal (Fal's CDN, signed URLs), so an
 * unrecognised extension produces a warning, never a rejection.
 */
const PLAYABLE_EXTENSIONS = ['.mp4', '.m4v', '.webm', '.ogv', '.ogg', '.mov'];

/** Beyond this, a clip is longer than most Fal video-input models accept. */
export const LONG_CLIP_SECONDS = 30;

export type ParsedVideoInput =
  | { kind: 'direct'; url: string }
  | { kind: 'archive-item'; identifier: string }
  | { kind: 'error'; message: string };

/**
 * Classify whatever the user pasted.
 *
 * `depth` guards the embed-unwrap recursion. Each unwrap strips a layer and so
 * strictly shortens the input, but this is user-supplied text going into an
 * iframe `src`, so it gets a hard stop rather than an argument about why it
 * can't loop.
 */
export function parseVideoInput(raw: string, depth = 0): ParsedVideoInput {
  const trimmed = raw.trim();
  if (!trimmed) return { kind: 'error', message: 'Paste a video URL first.' };
  if (depth > 3) return { kind: 'error', message: 'That URL is wrapped in too many player links.' };

  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return { kind: 'error', message: 'That doesn’t look like a URL — include the https:// prefix.' };
  }

  // The resolved URL ends up as an iframe `src` and as a `video_url` sent to
  // Fal, so anything that isn't plain HTTP(S) is refused right here — not
  // filtered downstream where a new caller could miss it.
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return {
      kind: 'error',
      message: `Only http:// and https:// URLs can be added (that one is ${u.protocol}).`,
    };
  }

  // Someone copied an embed straight off the board. Unwrap it rather than
  // wrapping our player around our player.
  if (u.pathname.endsWith('/embed-video.html')) {
    const inner = u.searchParams.get('url');
    if (!inner) return { kind: 'error', message: 'That player URL has no ?url= video inside it.' };
    return parseVideoInput(inner, depth + 1);
  }

  // An archive.org *details* page is what you get from the address bar; it's
  // HTML, not video. Resolve it through the item's metadata instead.
  const host = u.hostname.toLowerCase();
  if ((host === 'archive.org' || host.endsWith('.archive.org')) && u.pathname.startsWith('/details/')) {
    const identifier = u.pathname.split('/').filter(Boolean)[1];
    if (!identifier) return { kind: 'error', message: 'That archive.org URL has no item identifier in it.' };
    return { kind: 'archive-item', identifier: decodeURIComponent(identifier) };
  }

  return { kind: 'direct', url: u.toString() };
}

/** The item metadata endpoint. Sends `Access-Control-Allow-Origin: *`, so the
 *  panel can read it directly — no backend needed, which keeps this a
 *  Flavor-3 app. */
export function archiveMetadataUrl(identifier: string): string {
  return `https://archive.org/metadata/${encodeURIComponent(identifier)}`;
}

export type ArchiveFile = { name?: unknown; format?: unknown; size?: unknown };
export type ArchiveMetadata = { files?: unknown };

export type ArchiveVideoPick = {
  url: string;
  name: string;
  bytes: number | null;
  format: string | null;
};

/** `size` arrives as a decimal string on most files and is absent on some. */
function fileBytes(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Encode per path segment — a file name may contain slashes (derivative
 *  folders like `<id>.thumbs/frame.jpg`), and those must stay slashes. */
function downloadUrl(identifier: string, name: string): string {
  const path = name.split('/').map(encodeURIComponent).join('/');
  return `https://archive.org/download/${encodeURIComponent(identifier)}/${path}`;
}

/**
 * Choose the file to actually play from an item's metadata.
 *
 * Smallest playable file wins. Archive.org items typically carry a huge
 * preservation master alongside a small derivative of the same content (a
 * 1.6 GB MPEG4 next to a 55 MB h.264), and for previewing on a board — and
 * for handing to a model — the derivative is the one you want. Anyone who
 * needs the master can paste its download URL directly.
 */
export function pickArchiveVideo(
  identifier: string,
  meta: ArchiveMetadata,
): ArchiveVideoPick | { error: string } {
  const files = Array.isArray(meta.files) ? (meta.files as ArchiveFile[]) : [];
  const candidates = files
    .map((f) => ({
      name: typeof f.name === 'string' ? f.name : '',
      format: typeof f.format === 'string' ? f.format : null,
      bytes: fileBytes(f.size),
    }))
    .filter((f) => f.name && PLAYABLE_EXTENSIONS.some((ext) => f.name.toLowerCase().endsWith(ext)));

  if (candidates.length === 0) {
    return { error: 'That archive.org item has no browser-playable video file (no MP4/WebM/MOV).' };
  }

  // Unsized files sort last: an unknown size can't be compared, and every item
  // that has a derivative reports its size.
  const best = candidates.sort((a, b) => (a.bytes ?? Infinity) - (b.bytes ?? Infinity))[0];

  return {
    url: downloadUrl(identifier, best.name),
    name: best.name,
    bytes: best.bytes,
    format: best.format,
  };
}

/** Warn when the container probably won't play, without blocking it. */
export function containerWarning(url: string): string | null {
  let pathname: string;
  try {
    pathname = new URL(url).pathname.toLowerCase();
  } catch {
    return null;
  }
  const lastSegment = pathname.split('/').pop() ?? '';
  const dot = lastSegment.lastIndexOf('.');
  // No extension is the common, healthy case for CDN and signed URLs.
  if (dot <= 0) return null;
  const ext = lastSegment.slice(dot);
  if (PLAYABLE_EXTENSIONS.includes(ext)) return null;
  return `${ext} isn’t a container browsers reliably play — the board embed may show nothing even if Fal can read it.`;
}

/**
 * Board size for the embed, preserving the video's own shape. Falls back to
 * 16:9 when the probe couldn't read dimensions (an audio-only file, or a
 * server that refused the metadata range request).
 */
export function embedBox(
  videoWidth: number,
  videoHeight: number,
  maxWidth = 640,
): { width: number; height: number } {
  if (!Number.isFinite(videoWidth) || !Number.isFinite(videoHeight) || videoWidth <= 0 || videoHeight <= 0) {
    return { width: maxWidth, height: Math.round((maxWidth * 9) / 16) };
  }
  return { width: maxWidth, height: Math.round((maxWidth * videoHeight) / videoWidth) };
}

/** `634.9` → `10:35`. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const total = Math.round(seconds);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

/** `55352522` → `52.8 MB`. */
export function formatBytes(bytes: number | null): string | null {
  if (bytes === null || !Number.isFinite(bytes) || bytes <= 0) return null;
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return `${Math.round(bytes / 1024)} KB`;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}
