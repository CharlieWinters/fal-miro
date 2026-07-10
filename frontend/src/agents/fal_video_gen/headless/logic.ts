import { api, videoEmbedUrl, type StatusResponse } from '../../../lib/api';
import {
  asPreviewUrl,
  createEmbedAtPosition,
  createImageBelow,
  deleteItem,
  getImageAspectRatio,
  getImageRef,
  getStickyText,
  makePlaceholderDataUrl,
  parseRatio,
  replaceImageContent,
  resolveAbsolutePosition,
} from '../../../shared/boardHelpers';
import {
  addActiveJob,
  removeActiveJob,
  setItemGenerationSettings,
  type GenSettings,
} from '../../../shared/storage';
import { estimateCostUSD, reportedInferenceSeconds } from '../../../shared/cost';
import { bindSeedanceReferences, type Ref } from '../../../shared/referenceBinding';
import { unwrapVideoEmbedUrl } from '../../../lib/api';
import { broadcastUpdate } from '../../../headless/communications';

export type VideoGenPayload = {
  endpointId: string;
  /** The board image used as the source frame (image-to-video). */
  sourceImageId?: string;
  /** Sticky driving the prompt (optional). */
  stickyId?: string;
  input: Record<string, unknown>;
  placeholderRatio?: string;
  referenceField?: { name: string; multiple: boolean; required: boolean };
  /**
   * First-last-frame models: the two board images to use, and the schema field
   * names they map to (e.g. first_frame_url / last_frame_url).
   */
  frames?: { firstImageId?: string; lastImageId?: string; firstField: string; lastField: string };
  /**
   * Reference-to-video: board items woven into one shot.
   * - Seedance (default): images → image_urls, video embeds → video_urls, and
   *   the prompt is adapted to @Image1 / @Video1 tokens from the board titles.
   * - Veo (`blend: true`): images only, passed as-is into image_urls and blended
   *   ("ingredients"); no @token rewrite, no video refs.
   */
  references?: { imageIds?: string[]; videoIds?: string[]; blend?: boolean };
};

export type VideoGenResult = {
  requestId: string;
  embedItemId: string;
  outputUrl: string;
};

export async function run(payload: unknown, requestId = ''): Promise<VideoGenResult> {
  const {
    endpointId,
    sourceImageId,
    stickyId,
    input = {},
    placeholderRatio,
    referenceField,
    frames,
    references,
  } = (payload ?? {}) as VideoGenPayload;

  if (!endpointId) throw new Error('endpointId is required');

  const finalInput: Record<string, unknown> = { ...input };
  if (!finalInput.prompt && stickyId) {
    const text = await getStickyText(stickyId);
    if (text) finalInput.prompt = text;
  }

  // Track the board items this video is generated from (for lineage tracing).
  const parents = new Set<string>();
  if (stickyId) parents.add(stickyId);
  // The source frame doubles as the embed's preview thumbnail.
  let sourceUrl: string | undefined;

  if (references) {
    // Reference-to-video: resolve each board reference to a URL.
    broadcastUpdate({ requestId, status: 'queued', message: 'Resolving references…' });
    const images: Ref[] = [];
    for (const id of references.imageIds ?? []) {
      const r = await getImageRef(id);
      if (r) {
        images.push({ url: r.url, title: r.title });
        parents.add(id);
      }
    }
    if (!finalInput.prompt || typeof finalInput.prompt !== 'string') {
      throw new Error('A prompt is required — describe the shot.');
    }

    if (references.blend) {
      // Veo: images only, blended as "ingredients" — no @token rewrite.
      if (images.length === 0) {
        throw new Error('Select at least one reference image on the board.');
      }
      finalInput.image_urls = images.map((r) => r.url);
      console.log(`[fal_video_gen] blend references → ${images.length} image(s)`);
    } else {
      // Seedance: images + video embeds, prompt adapted to @Image/@Video tokens.
      const videos: Ref[] = [];
      for (const id of references.videoIds ?? []) {
        const v = await getEmbedVideoRef(id);
        if (v) {
          videos.push(v);
          parents.add(id);
        }
      }
      if (images.length === 0 && videos.length === 0) {
        throw new Error('Select at least one reference image or video on the board.');
      }
      const bound = bindSeedanceReferences({ prompt: finalInput.prompt, images, videos });
      if (bound.image_urls.length) finalInput.image_urls = bound.image_urls;
      if (bound.video_urls.length) finalInput.video_urls = bound.video_urls;
      finalInput.prompt = bound.prompt;
      console.log(
        `[fal_video_gen] references → ${images.length} image(s), ${videos.length} video(s)`,
      );
    }
    // First image doubles as the placeholder/embed preview thumbnail.
    sourceUrl = images[0]?.url;
  } else if (frames) {
    // First-last-frame: resolve both board images into the two frame fields.
    broadcastUpdate({ requestId, status: 'queued', message: 'Reading frames…' });
    if (frames.firstImageId) {
      const r = await getImageRef(frames.firstImageId);
      if (r) {
        finalInput[frames.firstField] = r.url;
        sourceUrl = r.url;
      }
      parents.add(frames.firstImageId);
    }
    if (frames.lastImageId) {
      const r = await getImageRef(frames.lastImageId);
      if (r) finalInput[frames.lastField] = r.url;
      parents.add(frames.lastImageId);
    }
    if (isEmpty(finalInput[frames.firstField]) || isEmpty(finalInput[frames.lastField])) {
      throw new Error('Set both a first frame and a last frame from the board.');
    }
  } else {
    // Single source frame → the model's image field (image-to-video).
    if (referenceField && sourceImageId && isEmpty(finalInput[referenceField.name])) {
      broadcastUpdate({ requestId, status: 'queued', message: 'Reading source image…' });
      const ref = await getImageRef(sourceImageId);
      if (ref) {
        finalInput[referenceField.name] = ref.url;
        sourceUrl = ref.url;
      }
      parents.add(sourceImageId);
    }
    if (referenceField?.required && isEmpty(finalInput[referenceField.name])) {
      throw new Error('Select an image on the board to use as the source frame.');
    }
  }

  // Match the placeholder to the anchor frame's aspect ratio when unset.
  const anchorId =
    references?.imageIds?.[0] ??
    references?.videoIds?.[0] ??
    frames?.firstImageId ??
    sourceImageId ??
    stickyId;
  let ratio = placeholderRatio;
  if (!ratio && anchorId) {
    ratio = (await getImageAspectRatio(anchorId)) ?? undefined;
  }
  if (!ratio) ratio = '16:9';

  // Placeholder below the anchor frame.
  broadcastUpdate({ requestId, status: 'queued', message: 'Placing placeholder…' });
  const { id: placeholderId, x: targetX, y: targetY } = await createImageBelow({
    sourceItemId: anchorId,
    url: makePlaceholderDataUrl(ratio, 'Generating video…'),
    ratio,
    title: 'Fal · Generating video',
  });

  // Submit.
  broadcastUpdate({ requestId, status: 'running', message: 'Submitting to Fal…' });
  let falRequestId: string;
  try {
    const created = await api.run({ endpointId, input: finalInput });
    falRequestId = created.requestId;
  } catch (err) {
    await replaceImageContent(
      placeholderId,
      makePlaceholderDataUrl(ratio, 'Failed to start'),
      'Fal · Failed',
      { x: targetX, y: targetY },
    );
    throw err;
  }

  const settings: GenSettings = {
    endpointId,
    input: finalInput,
    ratio,
    ...(stickyId ? { sourceStickyId: stickyId } : {}),
    ...(parents.size ? { parents: Array.from(parents) } : {}),
  };
  await addActiveJob({
    requestId: falRequestId,
    endpointId,
    placeholderId,
    targetPosition: { x: targetX, y: targetY },
    kind: 'video',
    createdAt: Date.now(),
    settings,
  });

  // Poll (video gen is slow — be patient). A hard error cleans up the
  // placeholder instead of leaving it stuck on "Generating video…".
  broadcastUpdate({ requestId, status: 'running', message: 'Queued on Fal…', falRequestId });

  // Track when the job actually starts running (not just queued) so we can bill
  // time-based models by the elapsed compute time, not the output length.
  let runStartedAt: number | undefined;
  let final: StatusResponse;
  try {
    final = await pollStatus(endpointId, falRequestId, (s) => {
      if (runStartedAt === undefined && s.status !== 'QUEUED') runStartedAt = Date.now();
      broadcastUpdate({
        requestId,
        status: 'running',
        message:
          s.status === 'QUEUED' && typeof s.queuePosition === 'number'
            ? `Queued (position ${s.queuePosition})…`
            : `Fal ${s.status.toLowerCase()}…`,
      });
    });
  } catch (err) {
    // A timeout doesn't mean failure — leave the placeholder + ledger entry so
    // resume_jobs finalizes it on the next board load.
    if (isTimeout(err)) {
      broadcastUpdate({
        requestId,
        status: 'failed',
        message: 'Still generating — it will finish in the background. Reopen the board to collect it.',
      });
      throw err;
    }
    await replaceImageContent(
      placeholderId,
      makePlaceholderDataUrl(ratio, 'Failed'),
      'Fal · Failed',
      { x: targetX, y: targetY },
    );
    await removeActiveJob(falRequestId);
    throw err;
  }

  const outputUrl = final.output?.[0];
  if (final.status === 'SUCCEEDED' && outputUrl) {
    // Swap the placeholder image for an inline embed of the video player.
    const { width, height } = parseRatio(ratio, 720);
    const abs = await resolveAbsolutePosition(placeholderId);
    const embedX = abs?.absoluteX ?? targetX;
    const embedY = abs?.absoluteY ?? targetY;

    await deleteItem(placeholderId);
    const embed = await createEmbedAtPosition({
      url: videoEmbedUrl(outputUrl),
      x: embedX,
      y: embedY,
      width,
      height,
      previewUrl: asPreviewUrl(sourceUrl),
    });
    // Bill by elapsed compute time: Fal's reported inference time if present,
    // else the wall-clock run time we measured, else the requested duration.
    const measured = runStartedAt ? (Date.now() - runStartedAt) / 1000 : undefined;
    const billedSeconds =
      reportedInferenceSeconds(final.data) ?? measured ?? durationSeconds(finalInput);
    settings.costUSD = await estimateCostUSD(endpointId, { units: 1, seconds: billedSeconds });
    await setItemGenerationSettings(embed.id, settings);
    await removeActiveJob(falRequestId);
    return { requestId: falRequestId, embedItemId: embed.id, outputUrl };
  }

  await replaceImageContent(
    placeholderId,
    makePlaceholderDataUrl(ratio, 'Failed'),
    `Fal · ${final.status}`,
    { x: targetX, y: targetY },
  );
  await removeActiveJob(falRequestId);
  throw new Error(`Generation ${final.status}${outputUrl ? '' : ' (no output returned)'}`);
}

function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
}

/** Resolve a board video embed to its underlying Fal video URL + board title. */
async function getEmbedVideoRef(itemId: string): Promise<Ref | null> {
  try {
    const item = (await miro.board.getById(itemId)) as
      | { type?: string; url?: string; title?: string }
      | null;
    if (!item || item.type !== 'embed' || !item.url) return null;
    const url = unwrapVideoEmbedUrl(item.url);
    if (!url) return null;
    return { url, title: (item.title ?? '').trim() || undefined };
  } catch (e) {
    console.warn('[fal_video_gen] getEmbedVideoRef failed', itemId, e);
    return null;
  }
}

/** A poll timeout (job may still be running) vs. a real failure. */
function isTimeout(err: unknown): boolean {
  return err instanceof Error && err.name === 'PollTimeout';
}

/** Billing units for video ≈ duration in seconds (e.g. "8s" → 8). */
function durationSeconds(input: Record<string, unknown>): number {
  const d = input.duration;
  if (typeof d === 'number') return d;
  if (typeof d === 'string') {
    const n = parseInt(d, 10);
    if (!Number.isNaN(n)) return n;
  }
  return 1;
}

async function pollStatus(
  endpointId: string,
  requestId: string,
  onTick: (s: StatusResponse) => void,
  intervalMs = 5000,
  timeoutMs = 15 * 60 * 1000,
): Promise<StatusResponse> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const s = await api.getStatus(endpointId, requestId);
    onTick(s);
    if (s.status === 'SUCCEEDED' || s.status === 'FAILED' || s.status === 'UNKNOWN') {
      return s;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  const err = new Error(`Request ${requestId} timed out after ${timeoutMs / 1000}s`);
  err.name = 'PollTimeout';
  throw err;
}
