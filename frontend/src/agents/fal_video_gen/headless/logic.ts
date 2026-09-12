import { api, videoEmbedUrl, type StatusResponse } from '../../../lib/api';
import {
  asPreviewUrl,
  createEmbedAtPosition,
  createImageAtAbsolute,
  createImageBelow,
  deleteItem,
  getAudioRef,
  getImageAspectRatio,
  getImageRef,
  getStickyText,
  getVideoRef,
  makePlaceholderDataUrl,
  parseRatio,
  replaceImageContent,
  resolveAbsolutePosition,
  resolveBelowFrameBox,
  resolvePlaceholderAnchor,
  snapFrameRatio,
} from '../../../shared/boardHelpers';
import { describeFalError } from '../../../shared/falError';
import {
  addActiveJob,
  removeActiveJob,
  setItemGenerationSettings,
  type GenSettings,
} from '../../../shared/storage';
import { estimateCostUSD, reportedInferenceSeconds } from '../../../shared/cost';
import { bindVideoReferences, type Ref } from '../../../shared/referenceBinding';
import { parseFalInputSchema, pickAspectRatioField } from '../../../shared/schema';
import { broadcastUpdate } from '../../../headless/communications';
import { POLL_BUDGET, pollStatus as sharedPollStatus, shouldLeaveForResume as isTimeout } from '../../../shared/pollStatus';

// Polling lives in shared/pollStatus; this agent only chooses its budget.
const pollStatus = (endpointId: string, requestId: string, onTick: (s: StatusResponse) => void) =>
  sharedPollStatus(endpointId, requestId, onTick, POLL_BUDGET.video);


export type VideoGenPayload = {
  endpointId: string;
  /** The board image used as the source frame (image-to-video). */
  sourceImageId?: string;
  /** Sticky driving the prompt (optional). */
  stickyId?: string;
  input: Record<string, unknown>;
  placeholderRatio?: string;
  referenceField?: { name: string; multiple: boolean; required: boolean };
  /** The board video embed used as the source clip (video-to-video / edit models). */
  sourceVideoId?: string;
  /** Board video embeds for a `video_urls`-style array field. */
  sourceVideoIds?: string[];
  videoReferenceField?: { name: string; multiple: boolean; required: boolean };
  /**
   * First-last-frame models: the two board images to use, and the schema field
   * names they map to (e.g. first_frame_url / last_frame_url).
   */
  frames?: { firstImageId?: string; lastImageId?: string; firstField: string; lastField: string };
  /**
   * Reference-to-video: board items woven into one shot.
   * - Seedance (default): images → image_urls, video embeds → video_urls,
   *   audio embeds → audio_urls (only for models whose schema declares an
   *   audio field), and the prompt is adapted to @Image1 / @Video1 / @Audio1
   *   tokens from the board titles.
   * - Veo (`blend: true`): images only, passed as-is into image_urls and blended
   *   ("ingredients"); no @token rewrite, no video/audio refs.
   */
  references?: {
    imageIds?: string[];
    videoIds?: string[];
    audioIds?: string[];
    blend?: boolean;
    /**
     * The input field each modality belongs in, read off the model's schema by
     * the panel. Absent on jobs persisted before this existed, which
     * resume_jobs can still replay — hence the Seedance-shaped fallbacks at
     * the use site rather than required properties here.
     */
    fields?: { image?: string; video?: string; audio?: string };
  };
  /** The settings card this run was started from, if reopened from one — the
   *  output places beside it instead of below the usual source anchor. */
  cardAnchorId?: string;
  /** The frame the references were collected from, if any — takes placement
   *  priority over `cardAnchorId`: the output goes directly below this frame,
   *  sized to match its width (ratio snapped to the frame's own shape when
   *  it's close to a logical one, see `snapFrameRatio`). */
  referenceFrameId?: string;
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
    sourceVideoId,
    sourceVideoIds,
    videoReferenceField,
    cardAnchorId,
    referenceFrameId,
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
    //
    // Which input field each modality belongs in comes from the panel, which
    // read it off this model's schema. The fallbacks are Seedance's names, and
    // exist only for jobs persisted before the panel started sending them —
    // resume_jobs replays those payloads verbatim after a board reload.
    const imageField = references.fields?.image ?? 'image_urls';
    const videoField = references.fields?.video ?? 'video_urls';
    const audioField = references.fields?.audio ?? 'audio_urls';
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
      finalInput[imageField] = images.map((r) => r.url);
      console.log(`[fal_video_gen] blend references → ${images.length} image(s) → ${imageField}`);
    } else {
      // Seedance: images + video/audio embeds, prompt adapted to @Image/@Video/@Audio tokens.
      const videos: Ref[] = [];
      for (const id of references.videoIds ?? []) {
        const v = await getVideoRef(id);
        if (v) {
          videos.push(v);
          parents.add(id);
        }
      }
      const audios: Ref[] = [];
      for (const id of references.audioIds ?? []) {
        const a = await getAudioRef(id);
        if (a) {
          audios.push(a);
          parents.add(id);
        }
      }
      if (images.length === 0 && videos.length === 0 && audios.length === 0) {
        throw new Error('Select at least one reference image, video, or audio clip on the board.');
      }
      const bound = bindVideoReferences({
        endpointId,
        prompt: finalInput.prompt,
        images,
        videos,
        audios,
      });
      if (bound.images.length) finalInput[imageField] = bound.images;
      if (bound.videos.length) finalInput[videoField] = bound.videos;
      if (bound.audios.length) finalInput[audioField] = bound.audios;
      finalInput.prompt = bound.prompt;
      console.log(
        `[fal_video_gen] references → ${images.length} image(s)→${imageField}, ` +
          `${videos.length} video(s)→${videoField}, ${audios.length} audio→${audioField}`,
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

    // Single/multi source video → the model's video field (video-to-video / edit).
    if (videoReferenceField) {
      broadcastUpdate({ requestId, status: 'queued', message: 'Reading source video…' });
      if (videoReferenceField.multiple) {
        const urls: string[] = [];
        for (const id of sourceVideoIds ?? []) {
          const v = await getVideoRef(id);
          if (v) {
            urls.push(v.url);
            parents.add(id);
          }
        }
        if (urls.length) finalInput[videoReferenceField.name] = urls;
      } else if (sourceVideoId && isEmpty(finalInput[videoReferenceField.name])) {
        const v = await getVideoRef(sourceVideoId);
        if (v) finalInput[videoReferenceField.name] = v.url;
        parents.add(sourceVideoId);
      }
      if (videoReferenceField.required && isEmpty(finalInput[videoReferenceField.name])) {
        throw new Error('Select a Fal video on the board to use as the source clip.');
      }
    }
  }

  // Match the placeholder to the anchor frame's aspect ratio when unset.
  const anchorId =
    references?.imageIds?.[0] ??
    references?.videoIds?.[0] ??
    frames?.firstImageId ??
    sourceImageId ??
    sourceVideoId ??
    stickyId;
  let ratio = placeholderRatio;
  if (!ratio && anchorId) {
    ratio = (await getImageAspectRatio(anchorId)) ?? undefined;
  }
  if (!ratio) ratio = '16:9';

  // If the references came from a frame, that frame takes placement priority:
  // the output goes directly below it, sized to match its width, ratio
  // snapped to the frame's own shape when that's close to a logical one.
  let placementBox: { x: number; y: number; width: number; height: number } | null = null;
  if (referenceFrameId) {
    const frame = await resolveAbsolutePosition(referenceFrameId);
    if (frame?.width && frame?.height) {
      const snapped = snapFrameRatio(frame.width, frame.height);
      if (snapped) {
        ratio = snapped;
        // Also feed the frame's shape into the actual generation request —
        // otherwise Fal generates at whatever ratio the form had, and the
        // mismatched result gets cropped to fit the frame-sized placeholder.
        try {
          const schemaRes = await api.getSchema(endpointId);
          const aspectField = pickAspectRatioField(parseFalInputSchema(schemaRes.openapi));
          const value = aspectField?.valueForRatio(snapped);
          if (aspectField && value) finalInput[aspectField.name] = value;
        } catch (e) {
          console.warn('[fal_video_gen] aspect-ratio override failed', e);
        }
      }
      placementBox = await resolveBelowFrameBox(referenceFrameId, ratio);
    }
  }

  // Placeholder below the reference frame (if any), else below the anchor
  // item (or beside the settings card, if this run was started from one).
  broadcastUpdate({ requestId, status: 'queued', message: 'Placing placeholder…' });
  let placeholderId: string, targetX: number, targetY: number;
  if (placementBox) {
    const placed = await createImageAtAbsolute({
      url: makePlaceholderDataUrl(ratio, 'Generating video…'),
      x: placementBox.x,
      y: placementBox.y,
      width: placementBox.width,
      title: 'Fal · Generating video',
    });
    placeholderId = placed.id;
    targetX = placed.x;
    targetY = placed.y;
  } else {
    const { anchorId: placementAnchor, side } = await resolvePlaceholderAnchor(cardAnchorId, anchorId);
    const placed = await createImageBelow({
      sourceItemId: placementAnchor,
      url: makePlaceholderDataUrl(ratio, 'Generating video…'),
      ratio,
      title: 'Fal · Generating video',
      side,
    });
    placeholderId = placed.id;
    targetX = placed.x;
    targetY = placed.y;
  }

  // Submit.
  broadcastUpdate({ requestId, status: 'running', message: 'Submitting to Fal…' });
  let falRequestId: string;
  try {
    const created = await api.run({ endpointId, input: finalInput });
    falRequestId = created.requestId;
  } catch (err) {
    await replaceImageContent(
      placeholderId,
      makePlaceholderDataUrl(ratio, 'Failed to start', describeFalError(err)),
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
      makePlaceholderDataUrl(ratio, 'Failed', describeFalError(err)),
      'Fal · Failed',
      { x: targetX, y: targetY },
    );
    await removeActiveJob(falRequestId);
    throw err;
  }

  const outputUrl = final.output?.[0];
  if (final.status === 'SUCCEEDED' && outputUrl) {
    // Swap the placeholder image for an inline embed of the video player —
    // same box the placeholder was actually placed at, so a frame-anchored
    // generation keeps its frame-matched size instead of reverting to the
    // ratio's default (720px-capped) dimensions.
    const { width, height } = placementBox ?? parseRatio(ratio, 720);
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

