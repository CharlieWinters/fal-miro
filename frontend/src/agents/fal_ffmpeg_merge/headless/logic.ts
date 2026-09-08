import { api, videoEmbedUrl, type StatusResponse } from '../../../lib/api';
import {
  createEmbedAtPosition,
  createImageBelow,
  deleteItem,
  getImageAspectRatio,
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
import { broadcastUpdate } from '../../../headless/communications';
import { POLL_BUDGET, pollStatus as sharedPollStatus, shouldLeaveForResume as isTimeout } from '../../../shared/pollStatus';

// Polling lives in shared/pollStatus; this agent only chooses its budget.
const pollStatus = (endpointId: string, requestId: string, onTick: (s: StatusResponse) => void) =>
  sharedPollStatus(endpointId, requestId, onTick, POLL_BUDGET.merge);


export type FfmpegMergePayload = {
  endpointId: string;
  /** Already-resolved input for the FFmpeg endpoint (video_urls, or
   *  video_url + audio_url). The panel resolves board embeds to URLs. */
  input: Record<string, unknown>;
  /** Board item the placeholder/result is anchored below (first input). */
  anchorItemId?: string;
  /** Board items this output derives from — for lineage tracing. */
  parents?: string[];
  placeholderRatio?: string;
  /** Placeholder verb, e.g. "Merging…" (default) or "Adding sound…". */
  placeholderLabel?: string;
};

export type FfmpegMergeResult = {
  requestId: string;
  embedItemId: string;
  outputUrl: string;
};

/**
 * Runs a Fal FFmpeg merge endpoint (merge-videos / merge-audio-video) and drops
 * the resulting video back on the board as a player embed. Inputs arrive
 * already resolved to URLs — this agent just runs, polls, and places the result.
 */
export async function run(payload: unknown, requestId = ''): Promise<FfmpegMergeResult> {
  const {
    endpointId,
    input = {},
    anchorItemId,
    parents = [],
    placeholderRatio,
    placeholderLabel = 'Merging…',
  } = (payload ?? {}) as FfmpegMergePayload;

  if (!endpointId) throw new Error('endpointId is required');

  // Ratio: match the anchor video when we have it, else widescreen.
  let ratio = placeholderRatio;
  if (!ratio && anchorItemId) {
    ratio = (await getImageAspectRatio(anchorItemId)) ?? undefined;
  }
  if (!ratio) ratio = '16:9';

  broadcastUpdate({ requestId, status: 'queued', message: 'Placing placeholder…' });
  const { id: placeholderId, x: targetX, y: targetY } = await createImageBelow({
    sourceItemId: anchorItemId,
    url: makePlaceholderDataUrl(ratio, placeholderLabel),
    ratio,
    title: 'Fal · Working',
  });

  broadcastUpdate({ requestId, status: 'running', message: 'Submitting to Fal…' });
  let falRequestId: string;
  try {
    const created = await api.run({ endpointId, input });
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
    input,
    ratio,
    ...(parents.length ? { parents } : {}),
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
        message: 'Still merging — it will finish in the background. Reopen the board to collect it.',
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
  throw new Error(`Merge ${final.status}${outputUrl ? '' : ' (no output returned)'}`);
}


async function estimateCost(endpointId: string, units: number): Promise<number | undefined> {
  try {
    const est = await api.estimate(endpointId, Math.max(1, units));
    return est.costUSD ?? undefined;
  } catch {
    return undefined;
  }
}

