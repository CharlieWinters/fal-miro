import { api, type StatusResponse } from '../../../lib/api';
import {
  createImageAtAbsolute,
  createImageBelow,
  getConnectedReferenceImages,
  getImageAspectRatio,
  getImageRef,
  getImageUrl,
  getStickyText,
  makePlaceholderDataUrl,
  replaceImageContent,
  resolveAbsolutePosition,
  resolveBelowFrameBox,
  resolvePlaceholderAnchor,
  snapFrameRatio,
} from '../../../shared/boardHelpers';
import { describeFalError } from '../../../shared/falError';
import {
  addActiveJob,
  getActiveJobs,
  removeActiveJob,
  setItemGenerationSettings,
  type GenSettings,
} from '../../../shared/storage';
import { bindReferences, type Ref } from '../../../shared/referenceBinding';
import { parseFalInputSchema, pickAspectRatioField } from '../../../shared/schema';
import { broadcastUpdate } from '../../../headless/communications';

export type ImageGenPayload = {
  endpointId: string;
  /** Sticky note driving the prompt + placeholder position (optional). */
  stickyId?: string;
  /**
   * The image the user selected on the board as the source (image-primary flow,
   * e.g. image-to-image / edit models). Used first in the reference list and as
   * the placement anchor.
   */
  sourceImageId?: string;
  /**
   * Multiple selected source images (multi-image models like Nano Banana edit).
   * All are sent as references; the first anchors placement.
   */
  sourceImageIds?: string[];
  /** Model arguments built by the panel form. `prompt` may be filled here. */
  input: Record<string, unknown>;
  /** Ratio for the placeholder + final image sizing, e.g. "1:1". */
  placeholderRatio?: string;
  /**
   * Asset id detected from the prompt (e.g. "CHR01"), used to name the finished
   * image on the board instead of the generic "Fal · Generated". Optional.
   */
  assetName?: string;
  /**
   * Which input field board-connected reference images flow into, and whether
   * it takes an array. Derived from the model schema by the panel. Omitted when
   * the model has no image input.
   */
  referenceField?: { name: string; multiple: boolean };
  /** The settings card this run was started from, if reopened from one — the
   *  output places beside it instead of below the usual source anchor. */
  cardAnchorId?: string;
  /** The frame the references were collected from, if any — takes placement
   *  priority over `cardAnchorId`: the output goes directly below this frame,
   *  sized to match its width (ratio snapped to the frame's own shape when
   *  it's close to a logical one, see `snapFrameRatio`). */
  referenceFrameId?: string;
};

export type ImageGenResult = {
  requestId: string;
  imageItemId: string;
  outputUrl: string;
};

export async function run(payload: unknown, requestId = ''): Promise<ImageGenResult> {
  const {
    endpointId,
    stickyId,
    sourceImageId,
    sourceImageIds = [],
    input = {},
    placeholderRatio,
    referenceField,
    assetName,
    cardAnchorId,
    referenceFrameId,
  } = (payload ?? {}) as ImageGenPayload;

  if (!endpointId) throw new Error('endpointId is required');

  // Title for the finished image: the detected asset id itself, or the generic
  // name when none was detected.
  const name = (assetName ?? '').trim();
  const finishedTitle = name || 'Fal · Generated';

  // Resolve the prompt: prefer what the form sent; otherwise read the sticky.
  const finalInput: Record<string, unknown> = { ...input };
  if (!finalInput.prompt && stickyId) {
    const text = await getStickyText(stickyId);
    if (text) finalInput.prompt = text;
  }
  if (!finalInput.prompt || typeof finalInput.prompt !== 'string') {
    throw new Error('A prompt is required (type one or select a sticky note).');
  }

  // Track the board items this asset is generated from (for lineage tracing).
  const parents = new Set<string>();
  if (stickyId) parents.add(stickyId);

  // Reference images: when the model has an image input and the form didn't
  // already set it, collect images connected to the sticky on the board and
  // pass them as data URIs (array for image_urls, first for single fields).
  if (referenceField && isEmpty(finalInput[referenceField.name])) {
    broadcastUpdate({ requestId, status: 'queued', message: 'Resolving references…' });
    const refs: Ref[] = [];
    const seen = new Set<string>();

    // 1) Explicitly-selected source image(s), in selection order. Multi-image
    //    models (e.g. Nano Banana edit) pass several; single-image ones, one.
    const selectedIds = sourceImageIds.length ? sourceImageIds : sourceImageId ? [sourceImageId] : [];
    for (const id of selectedIds) {
      if (seen.has(id)) continue;
      const r = await getImageRef(id);
      if (r) {
        refs.push({ url: r.url, title: r.title });
        seen.add(id);
        parents.add(id);
      }
    }
    // 2) Images connected to the first source (or to the sticky in text-primary flow).
    const anchorForRefs = selectedIds[0] ?? stickyId;
    if (anchorForRefs) {
      const connected = await getConnectedReferenceImages(anchorForRefs);
      for (const c of connected) {
        if (seen.has(c.miroImageId)) continue;
        const u = await getImageUrl(c.miroImageId);
        if (u) {
          refs.push({ url: u, title: c.title });
          seen.add(c.miroImageId);
          parents.add(c.miroImageId);
        }
      }
    }

    if (refs.length) {
      if (referenceField.multiple) {
        // Order by prompt mention + adapt the prompt (see referenceBinding).
        const bound = bindReferences({
          prompt: finalInput.prompt as string,
          refs,
          multiple: true,
          endpointId,
        });
        finalInput[referenceField.name] = bound.urls;
        finalInput.prompt = bound.prompt;
      } else {
        // Single-image model: the source image (or first connected) is THE input.
        finalInput[referenceField.name] = refs[0].url;
      }
      console.log(`[fal_image_gen] attached ${refs.length} reference image(s) → ${referenceField.name}`);
    }
  }

  // Match the placeholder to the source image's aspect ratio when we have one
  // and the form didn't specify a size — avoids a square box for edits/segments.
  const anchorImageId = sourceImageIds[0] ?? sourceImageId;
  let ratio = placeholderRatio;
  if (!ratio && anchorImageId) {
    ratio = (await getImageAspectRatio(anchorImageId)) ?? undefined;
  }
  if (!ratio) ratio = '1:1';

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
          console.warn('[fal_image_gen] aspect-ratio override failed', e);
        }
      }
      placementBox = await resolveBelowFrameBox(referenceFrameId, ratio);
    }
  }

  // Offset parallel generations from the same sticky so they don't stack.
  const activeBefore = await getActiveJobs();
  const siblingOffsetIndex = stickyId
    ? activeBefore.filter((j) => j.settings.sourceStickyId === stickyId).length
    : 0;

  // 1. Drop a placeholder below the reference frame (if any), else below the
  //    sticky (or beside the settings card, if this run was started from one).
  broadcastUpdate({ requestId, status: 'queued', message: 'Placing placeholder…' });
  let placeholderId: string, targetX: number, targetY: number;
  if (placementBox) {
    const placed = await createImageAtAbsolute({
      url: makePlaceholderDataUrl(ratio, 'Generating image…'),
      x: placementBox.x,
      y: placementBox.y,
      width: placementBox.width,
      title: 'Fal · Generating',
    });
    placeholderId = placed.id;
    targetX = placed.x;
    targetY = placed.y;
  } else {
    const { anchorId: placementAnchor, side } = await resolvePlaceholderAnchor(cardAnchorId, anchorImageId ?? stickyId);
    const placed = await createImageBelow({
      sourceItemId: placementAnchor,
      url: makePlaceholderDataUrl(ratio, 'Generating image…'),
      ratio,
      title: 'Fal · Generating',
      siblingOffsetIndex,
      side,
    });
    placeholderId = placed.id;
    targetX = placed.x;
    targetY = placed.y;
  }

  // 2. Submit to Fal's queue via the backend.
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

  // 3. Persist the job so we can resume after a reload.
  const settings: GenSettings = {
    endpointId,
    input: finalInput,
    ratio,
    // Only include when present — Miro's setAppData rejects `undefined`.
    ...(stickyId ? { sourceStickyId: stickyId } : {}),
    ...(parents.size ? { parents: Array.from(parents) } : {}),
    ...(name ? { assetName: name } : {}),
  };
  await addActiveJob({
    requestId: falRequestId,
    endpointId,
    placeholderId,
    targetPosition: { x: targetX, y: targetY },
    kind: 'image',
    createdAt: Date.now(),
    settings,
  });

  // 4. Poll until done. A hard error (e.g. Fal rejects the inputs) cleans up the
  //    placeholder instead of leaving it stuck on "Generating…".
  broadcastUpdate({ requestId, status: 'running', message: 'Queued on Fal…', falRequestId });

  let final: StatusResponse;
  try {
    final = await pollStatus(endpointId, falRequestId, (s) => {
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

  // 5. Finalize.
  const outputUrl = final.output?.[0];
  if (final.status === 'SUCCEEDED' && outputUrl) {
    await replaceImageContent(placeholderId, outputUrl, finishedTitle, { x: targetX, y: targetY });
    settings.costUSD = await estimateCost(endpointId, Number(finalInput.num_images) || 1);
    await setItemGenerationSettings(placeholderId, settings);
    await removeActiveJob(falRequestId);
    return { requestId: falRequestId, imageItemId: placeholderId, outputUrl };
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

/** A poll timeout (job may still be running) vs. a real failure. */
function isTimeout(err: unknown): boolean {
  return err instanceof Error && err.name === 'PollTimeout';
}

/** Best-effort cost estimate (USD); undefined on any error. */
export async function estimateCost(endpointId: string, units: number): Promise<number | undefined> {
  try {
    const est = await api.estimate(endpointId, Math.max(1, units));
    return est.costUSD ?? undefined;
  } catch {
    return undefined;
  }
}

async function pollStatus(
  endpointId: string,
  requestId: string,
  onTick: (s: StatusResponse) => void,
  intervalMs = 4000,
  timeoutMs = 10 * 60 * 1000,
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
