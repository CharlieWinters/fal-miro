// Generic output placement — put whatever a model returns onto the board.
//
// Specialized agents know their output type; the generic agent (and resume for
// generic jobs) don't, so we classify the result URL and place it the same way
// the bespoke agents would: image → the image itself, video → the player embed,
// glb → the 3D viewer embed, everything else (audio, unknown) → a link/preview
// embed. Shared so fal_generic and resume_jobs stay in lockstep.

import { audioEmbedUrl, videoEmbedUrl, model3dEmbedUrl } from '../lib/api';
import {
  createEmbedAtPosition,
  deleteItem,
  parseRatio,
  replaceImageContent,
  resolveAbsolutePosition,
} from './boardHelpers';

export type OutputKind = 'image' | 'video' | 'model3d' | 'audio' | 'link';

/** Best-effort output type from a result URL's extension. */
export function classifyOutput(url: string): OutputKind {
  const u = url.split(/[?#]/)[0].toLowerCase();
  if (/\.(png|jpe?g|webp|gif|bmp|svg|avif)$/.test(u)) return 'image';
  if (/\.(mp4|webm|mov|m4v)$/.test(u)) return 'video';
  if (/\.(glb|gltf)$/.test(u)) return 'model3d';
  if (/\.(mp3|wav|ogg|m4a|flac|aac)$/.test(u)) return 'audio';
  return 'link';
}

/**
 * Place `url` onto the board, reusing the placeholder image at `placeholderId`.
 * Images swap in place; embed-based kinds delete the placeholder and drop the
 * right embed at its position. Returns the final item id + detected kind.
 */
export async function placeGenericOutput(opts: {
  placeholderId: string;
  targetPosition?: { x: number; y: number };
  ratio: string;
  url: string;
  title?: string;
}): Promise<{ itemId: string; kind: OutputKind }> {
  const { placeholderId, targetPosition, ratio, url, title = 'Fal · Generated' } = opts;
  const kind = classifyOutput(url);

  if (kind === 'image') {
    await replaceImageContent(placeholderId, url, title, targetPosition);
    return { itemId: placeholderId, kind };
  }

  // Embed-based: keep the placeholder's current spot, swap it for an embed.
  // Media (video / 3D) keeps the aspect ratio; audio / link get a compact bar.
  const isMedia = kind === 'video' || kind === 'model3d';
  const { width, height } = isMedia ? parseRatio(ratio, 720) : { width: 480, height: 140 };
  const abs = await resolveAbsolutePosition(placeholderId);
  const x = abs?.absoluteX ?? targetPosition?.x ?? 0;
  const y = abs?.absoluteY ?? targetPosition?.y ?? 0;
  await deleteItem(placeholderId);

  const embedUrl =
    kind === 'video'
      ? videoEmbedUrl(url)
      : kind === 'model3d'
        ? model3dEmbedUrl(url)
        : kind === 'audio'
          ? audioEmbedUrl(url)
          : url;
  const embed = await createEmbedAtPosition({ url: embedUrl, x, y, width, height });
  return { itemId: embed.id, kind };
}
