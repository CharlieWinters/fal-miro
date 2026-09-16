// The still image a video embed shows before you click it.
//
// Miro renders an inline embed as a preview card. Given no `previewUrl` it
// substitutes its own generic placeholder — verified live, an embed created
// with no preview came back carrying
// `https://mirostatic.com/partners-embed/preview-images/…`. That grey nothing
// is what a finished video has always looked like on the board, and it is not
// a failed load: it is Miro's default, and nothing was overriding it.
//
// An http(s) `previewUrl` *is* honoured and kept verbatim (also verified live:
// a fal.media image URL came back unchanged). A `data:` URI is not — Miro tries
// to rehost a preview through `uploadResourceFromUrl`, and that upload 400s on
// a data URI. So a poster has to be a URL something else is serving.
//
// Hence this module: get one http URL for the first frame, cheaply, and never
// let failing to get one break the generation that produced the video.

import { api } from '../lib/api';
import { asPreviewUrl } from './boardHelpers';
import { POLL_BUDGET, pollStatus } from './pollStatus';

/** ffmpeg on Fal: first/middle/last frame out of a video, $0.0002/second. */
const EXTRACT_FRAME = 'fal-ai/ffmpeg-api/extract-frame';

/** The first image URL in a status response, wherever the shape put it. */
function firstImageUrl(final: { output?: string[]; data?: Record<string, unknown> }): string | undefined {
  const fromOutput = final.output?.[0];
  if (fromOutput) return fromOutput;
  const images = (final.data as { images?: Array<{ url?: unknown }> } | undefined)?.images;
  const url = Array.isArray(images) ? images[0]?.url : undefined;
  return typeof url === 'string' ? url : undefined;
}

/**
 * A poster URL for a finished video, or undefined to leave Miro's placeholder
 * in place.
 *
 * `preferred` is a URL the caller already has — usually the first reference the
 * video was generated from. It is used when it happens to be public, which is
 * free and saves a call, but it often is not: `getImageUrl` hands back a data
 * URI for board images, and an image *uploaded* to Miro reports no `url` at
 * all (an image *created from* a URL keeps that URL, which is the case this
 * catches).
 *
 * Otherwise the first frame is extracted from the video itself — which is the
 * better poster anyway, being the actual opening frame rather than a reference
 * that may differ from it.
 *
 * Every failure is swallowed and returns undefined. A missing thumbnail is the
 * status quo; a thrown error here would lose a video that already generated.
 */
export type PosterDeps = {
  /** Test seams, same pattern as pollStatus's. */
  run?: (body: { endpointId: string; input: Record<string, unknown> }) => Promise<{ requestId: string }>;
  poll?: (
    endpointId: string,
    requestId: string,
  ) => Promise<{ status: string; output?: string[]; data?: Record<string, unknown> }>;
};

export async function resolveVideoPoster(
  videoUrl: string,
  preferred?: string | null,
  deps: PosterDeps = {},
): Promise<string | undefined> {
  const free = asPreviewUrl(preferred);
  if (free) return free;
  if (!asPreviewUrl(videoUrl)) return undefined; // nothing Fal could fetch

  const run = deps.run ?? api.run;
  const poll =
    deps.poll ?? ((endpointId: string, requestId: string) => pollStatus(endpointId, requestId, undefined, POLL_BUDGET.poster));

  try {
    const { requestId } = await run({
      endpointId: EXTRACT_FRAME,
      input: { video_url: videoUrl, frame_type: 'first' },
    });
    const final = await poll(EXTRACT_FRAME, requestId);
    if (final.status !== 'SUCCEEDED') return undefined;
    return asPreviewUrl(firstImageUrl(final));
  } catch (e) {
    console.warn('[videoPoster] no poster for this embed', e);
    return undefined;
  }
}
