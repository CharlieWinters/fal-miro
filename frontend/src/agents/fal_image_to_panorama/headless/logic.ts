import { api, panoramaEmbedUrl, type StatusResponse } from '../../../lib/api';
import {
  asPreviewUrl,
  createEmbedAtPosition,
  createImageBelow,
  deleteItem,
  getImageRef,
  getStickyText,
  makePlaceholderDataUrl,
  parseRatio,
  replaceImageContent,
  resolveAbsolutePosition,
  resolvePlaceholderAnchor,
} from '../../../shared/boardHelpers';
import { describeFalError } from '../../../shared/falError';
import {
  addActiveJob,
  removeActiveJob,
  setItemGenerationSettings,
  type GenSettings,
} from '../../../shared/storage';
import { broadcastUpdate } from '../../../headless/communications';
import { POLL_BUDGET, pollStatus as sharedPollStatus, shouldLeaveForResume as isTimeout } from '../../../shared/pollStatus';
import { estimateCostUSD } from '../../../shared/cost';

// Polling lives in shared/pollStatus; this agent only chooses its budget.
const pollStatus = (endpointId: string, requestId: string, onTick: (s: StatusResponse) => void) =>
  sharedPollStatus(endpointId, requestId, onTick, POLL_BUDGET.panorama);


export type ImageToPanoramaPayload = {
  endpointId: string;
  /** The board image the panorama is expanded from (image-primary). */
  sourceImageId?: string;
  /** Sticky driving the prompt (Hunyuan World requires a prompt). */
  stickyId?: string;
  input: Record<string, unknown>;
  /** Which schema field the source image flows into (e.g. image_url). */
  referenceField?: { name: string; multiple: boolean; required: boolean };
  /** The settings card this run was started from, if reopened from one — the
   *  output places beside it instead of below the usual source anchor. */
  cardAnchorId?: string;
};

export type ImageToPanoramaResult = {
  requestId: string;
  embedItemId: string;
  outputUrl: string;
};

// Equirectangular panoramas are 2:1 — anchor the placeholder + viewer to that.
const PANORAMA_RATIO = '2:1';

export async function run(payload: unknown, requestId = ''): Promise<ImageToPanoramaResult> {
  const {
    endpointId,
    sourceImageId,
    stickyId,
    input = {},
    referenceField,
    cardAnchorId,
  } = (payload ?? {}) as ImageToPanoramaPayload;

  if (!endpointId) throw new Error('endpointId is required');

  const finalInput: Record<string, unknown> = { ...input };
  if (!finalInput.prompt && stickyId) {
    const text = await getStickyText(stickyId);
    if (text) finalInput.prompt = text;
  }
  if (!finalInput.prompt || typeof finalInput.prompt !== 'string') {
    throw new Error('A prompt is required — describe the scene to expand into a panorama.');
  }

  const parents = new Set<string>();
  if (stickyId) parents.add(stickyId);

  // Resolve the source image into the model's image field.
  let sourceUrl: string | undefined;
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
    throw new Error('Select an image on the board to expand into a panorama.');
  }

  const ratio = PANORAMA_RATIO;

  broadcastUpdate({ requestId, status: 'queued', message: 'Placing placeholder…' });
  const { anchorId: placementAnchor, side } = await resolvePlaceholderAnchor(cardAnchorId, sourceImageId ?? stickyId);
  const { id: placeholderId, x: targetX, y: targetY } = await createImageBelow({
    sourceItemId: placementAnchor,
    url: makePlaceholderDataUrl(ratio, 'Generating panorama…'),
    ratio,
    title: 'Fal · Generating panorama',
    side,
  });

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
    kind: 'panorama',
    createdAt: Date.now(),
    settings,
  });

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
    // A timeout doesn't mean the job failed — Fal may still be working. Leave
    // the placeholder and the ledger entry so resume_jobs finalizes it on the
    // next board load, and tell the user rather than destroying the result.
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
    // Swap the placeholder for an interactive photosphere embed.
    const { width, height } = parseRatio(ratio, 720);
    const abs = await resolveAbsolutePosition(placeholderId);
    const embedX = abs?.absoluteX ?? targetX;
    const embedY = abs?.absoluteY ?? targetY;

    await deleteItem(placeholderId);
    const embed = await createEmbedAtPosition({
      url: panoramaEmbedUrl(outputUrl),
      x: embedX,
      y: embedY,
      width,
      height,
      // Preview: the source image if public, else the equirect itself.
      previewUrl: asPreviewUrl(sourceUrl) ?? outputUrl,
    });
    settings.costUSD = await estimateCostUSD(endpointId, { units: 1 });
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
  throw new Error(`Panorama ${final.status}${outputUrl ? '' : ' (no image returned)'}`);
}

function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
}



