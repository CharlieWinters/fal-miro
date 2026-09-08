import { api, model3dEmbedUrl, type StatusResponse } from '../../../lib/api';
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
  resolvePlaceholderAnchor,
} from '../../../shared/boardHelpers';
import {
  addActiveJob,
  removeActiveJob,
  setItemGenerationSettings,
  type GenSettings,
} from '../../../shared/storage';
import { broadcastUpdate } from '../../../headless/communications';
import { POLL_BUDGET, pollStatus as sharedPollStatus, shouldLeaveForResume as isTimeout } from '../../../shared/pollStatus';

// Polling lives in shared/pollStatus; this agent only chooses its budget.
const pollStatus = (endpointId: string, requestId: string, onTick: (s: StatusResponse) => void) =>
  sharedPollStatus(endpointId, requestId, onTick, POLL_BUDGET.model3d);


export type ImageTo3dPayload = {
  endpointId: string;
  /** The board image used as the source for reconstruction (image-primary). */
  sourceImageId?: string;
  /** Sticky driving an optional prompt (some 3D models take one). */
  stickyId?: string;
  input: Record<string, unknown>;
  /** Ratio for the placeholder box; the mesh viewer is square by default. */
  placeholderRatio?: string;
  /** Which schema field the source image flows into (e.g. input_image_url). */
  referenceField?: { name: string; multiple: boolean; required: boolean };
  /**
   * Multi-view models (e.g. Hunyuan3D v3): each board image mapped to a named
   * image field — front → input_image_url, plus optional back/left/right. Takes
   * precedence over `referenceField` when present.
   */
  viewImages?: Array<{ field: string; imageId: string }>;
  /** The settings card this run was started from, if reopened from one — the
   *  output places beside it instead of below the usual source anchor. */
  cardAnchorId?: string;
};

export type ImageTo3dResult = {
  requestId: string;
  embedItemId: string;
  outputUrl: string;
};

export async function run(payload: unknown, requestId = ''): Promise<ImageTo3dResult> {
  const {
    endpointId,
    sourceImageId,
    stickyId,
    input = {},
    placeholderRatio,
    referenceField,
    viewImages = [],
    cardAnchorId,
  } = (payload ?? {}) as ImageTo3dPayload;

  if (!endpointId) throw new Error('endpointId is required');

  const finalInput: Record<string, unknown> = { ...input };
  if (!finalInput.prompt && stickyId) {
    const text = await getStickyText(stickyId);
    if (text) finalInput.prompt = text;
  }

  // Track the board items this mesh came from (lineage).
  const parents = new Set<string>();
  if (stickyId) parents.add(stickyId);

  // Which board image anchors the placeholder (its ratio + position).
  let anchorImageId = sourceImageId;
  // The source image doubles as the embed's preview thumbnail.
  let sourceUrl: string | undefined;

  if (viewImages.length) {
    // Multi-view: resolve each named view into its image field.
    broadcastUpdate({ requestId, status: 'queued', message: 'Reading view images…' });
    anchorImageId = viewImages[0]?.imageId ?? sourceImageId;
    for (const { field, imageId } of viewImages) {
      if (isEmpty(finalInput[field])) {
        const ref = await getImageRef(imageId);
        if (ref) {
          finalInput[field] = ref.url;
          if (!sourceUrl) sourceUrl = ref.url;
        }
      }
      parents.add(imageId);
    }
  } else if (referenceField && sourceImageId && isEmpty(finalInput[referenceField.name])) {
    // Single source image → the model's image field.
    broadcastUpdate({ requestId, status: 'queued', message: 'Reading source image…' });
    const ref = await getImageRef(sourceImageId);
    if (ref) {
      finalInput[referenceField.name] = ref.url;
      sourceUrl = ref.url;
    }
    parents.add(sourceImageId);
  }
  if (referenceField?.required && isEmpty(finalInput[referenceField.name])) {
    throw new Error('Select an image on the board to turn into a 3D model.');
  }

  // Placeholder: match the anchor image's ratio when we have it, else square.
  let ratio = placeholderRatio;
  if (!ratio && anchorImageId) {
    ratio = (await getImageAspectRatio(anchorImageId)) ?? undefined;
  }
  if (!ratio) ratio = '1:1';

  broadcastUpdate({ requestId, status: 'queued', message: 'Placing placeholder…' });
  const { anchorId: placementAnchor, side } = await resolvePlaceholderAnchor(cardAnchorId, anchorImageId ?? stickyId);
  const { id: placeholderId, x: targetX, y: targetY } = await createImageBelow({
    sourceItemId: placementAnchor,
    url: makePlaceholderDataUrl(ratio, 'Generating 3D…'),
    ratio,
    title: 'Fal · Generating 3D',
    side,
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
    kind: 'model3d',
    createdAt: Date.now(),
    settings,
  });

  // Poll. 3D reconstruction is usually faster than video but can queue.
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
      makePlaceholderDataUrl(ratio, 'Failed'),
      'Fal · Failed',
      { x: targetX, y: targetY },
    );
    await removeActiveJob(falRequestId);
    throw err;
  }

  // The backend's output extractor prefers the .glb URL.
  const outputUrl = final.output?.[0];
  if (final.status === 'SUCCEEDED' && outputUrl) {
    // Swap the placeholder image for an inline embed of the 3D viewer.
    const { width, height } = parseRatio(ratio, 720);
    const abs = await resolveAbsolutePosition(placeholderId);
    const embedX = abs?.absoluteX ?? targetX;
    const embedY = abs?.absoluteY ?? targetY;

    await deleteItem(placeholderId);
    const embed = await createEmbedAtPosition({
      url: model3dEmbedUrl(outputUrl),
      x: embedX,
      y: embedY,
      width,
      height,
      previewUrl: asPreviewUrl(sourceUrl),
    });
    settings.costUSD = await estimateCost(endpointId, 1);
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
  throw new Error(`3D generation ${final.status}${outputUrl ? '' : ' (no mesh returned)'}`);
}

function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
}


async function estimateCost(endpointId: string, units: number): Promise<number | undefined> {
  try {
    const est = await api.estimate(endpointId, Math.max(1, units));
    return est.costUSD ?? undefined;
  } catch {
    return undefined;
  }
}

