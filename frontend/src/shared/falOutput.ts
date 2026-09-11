// Output extraction for client-mode (direct-to-Fal) generation — a browser
// copy of backend/src/lib/output.ts's pure functions, used only when
// lib/api.ts is bypassing the backend entirely (see connectionMode()). Keep
// these two files in sync by hand; they can't share a module across the
// separate frontend/backend packages.

type UrlObj = { url?: unknown };

function pushUrl(urls: string[], obj: unknown): void {
  if (obj && typeof obj === 'object' && typeof (obj as UrlObj).url === 'string') {
    urls.push((obj as UrlObj).url as string);
  } else if (typeof obj === 'string' && /^https?:\/\//.test(obj)) {
    urls.push(obj);
  }
}

/** Pull the first .glb URL out of a 3D model result, if any. */
export function firstGlbUrl(data: Record<string, unknown>): string | null {
  for (const key of ['model_mesh', 'model_glb', 'mesh', 'model_obj']) {
    const obj = data[key];
    const url =
      obj && typeof obj === 'object' ? (obj as UrlObj).url : typeof obj === 'string' ? obj : null;
    if (typeof url === 'string' && /\.glb(\?|$)/i.test(url)) return url;
  }
  return null;
}

/** Pick a playable animated glb from a Meshy rigging result (walk first). */
export function firstRiggedGlb(data: Record<string, unknown>): string | null {
  const pick = (f: unknown): string | null =>
    f && typeof f === 'object' && typeof (f as UrlObj).url === 'string' ? ((f as UrlObj).url as string) : null;
  const ba = (data.basic_animations as Record<string, unknown> | undefined) ?? {};
  const animations = data.animations;
  const firstAnim =
    Array.isArray(animations) && animations.length
      ? pick((animations[0] as Record<string, unknown> | undefined)?.animation_glb)
      : null;
  return pick(ba.walking_glb) ?? pick(ba.running_glb) ?? firstAnim ?? pick(data.rigged_character_glb);
}

export function extractOutputUrls(data: unknown): string[] {
  if (!data || typeof data !== 'object') return [];
  const d = data as Record<string, unknown>;
  const urls: string[] = [];

  if (Array.isArray(d.images)) d.images.forEach((x) => pushUrl(urls, x));
  pushUrl(urls, d.image);
  pushUrl(urls, d.video);
  pushUrl(urls, d.audio);
  if (Array.isArray(d.audios)) d.audios.forEach((x) => pushUrl(urls, x));
  pushUrl(urls, d.audio_url);
  pushUrl(urls, d.video_url);
  if (Array.isArray(d.masks)) d.masks.forEach((x) => pushUrl(urls, x));
  const glb = firstGlbUrl(d);
  if (glb) urls.push(glb);
  else {
    pushUrl(urls, d.model_mesh);
    pushUrl(urls, d.model_glb);
    pushUrl(urls, d.mesh);
    pushUrl(urls, d.model_obj);
  }
  const rig = firstRiggedGlb(d);
  if (rig) urls.push(rig);
  // Hunyuan Motion: an FBX animation (mesh + skeleton + clip). `motion_json`
  // is the same motion as raw arrays and is not something the board can show,
  // so it is deliberately not treated as an output URL.
  pushUrl(urls, d.fbx_file);

  return urls;
}

export type FalStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN';

/** Normalize Fal's queue status to a small, stable enum for the frontend. */
export function normalizeStatus(falStatus: string | undefined): FalStatus {
  switch (falStatus) {
    case 'IN_QUEUE':
      return 'QUEUED';
    case 'IN_PROGRESS':
      return 'RUNNING';
    case 'COMPLETED':
      return 'SUCCEEDED';
    default:
      return (falStatus as FalStatus) || 'UNKNOWN';
  }
}
