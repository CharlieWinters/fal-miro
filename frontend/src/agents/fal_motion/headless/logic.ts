import { api, motionEmbedUrl, type StatusResponse } from '../../../lib/api';
import {
  createEmbedAtPosition,
  createImageBelow,
  deleteItem,
  getStickyText,
  makePlaceholderDataUrl,
  parseRatio,
  replaceImageContent,
  resolveAbsolutePosition,
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
  sharedPollStatus(endpointId, requestId, onTick, POLL_BUDGET.motion);

/** The motion viewer is portrait: a standing figure with room to walk. */
const MOTION_RATIO = '3:4';

export type MotionPayload = {
  endpointId: string;
  /** Model input: { prompt, duration, seed?, guidance_scale? } from the panel. */
  input: Record<string, unknown>;
  /** Sticky that supplied (or should supply) the prompt, if any. */
  stickyId?: string;
  /** Board item to place the result beside; defaults to the sticky. */
  anchorItemId?: string;
};

export type MotionResult = {
  requestId: string;
  embedItemId: string;
  outputUrl: string;
};

/**
 * Text → skeletal animation (Hunyuan Motion). The model returns an FBX clip on
 * a mannequin; the board gets a looping embed of it (embed-motion.html), with
 * the same placeholder → poll → swap flow the other media agents use.
 */
export async function run(payload: unknown, requestId = ''): Promise<MotionResult> {
  const { endpointId, input = {}, stickyId, anchorItemId } = (payload ?? {}) as MotionPayload;
  if (!endpointId) throw new Error('endpointId is required');

  const finalInput: Record<string, unknown> = { ...input };
  if (typeof finalInput.prompt !== 'string' || !finalInput.prompt.trim()) {
    if (stickyId) finalInput.prompt = await getStickyText(stickyId);
  }
  if (typeof finalInput.prompt !== 'string' || !finalInput.prompt.trim()) {
    throw new Error('Describe the motion (a prompt or a selected sticky note).');
  }
  // The board can only show the FBX; the raw-JSON variant has nowhere to go.
  finalInput.output_format = 'fbx';

  const parents = new Set<string>();
  if (stickyId) parents.add(stickyId);
  if (anchorItemId) parents.add(anchorItemId);

  broadcastUpdate({ requestId, status: 'queued', message: 'Placing placeholder…' });
  const { id: placeholderId, x: targetX, y: targetY } = await createImageBelow({
    sourceItemId: anchorItemId ?? stickyId,
    url: makePlaceholderDataUrl(MOTION_RATIO, 'Generating motion…'),
    ratio: MOTION_RATIO,
    title: 'Fal · Generating motion',
  });

  broadcastUpdate({ requestId, status: 'running', message: 'Submitting to Fal…' });
  let falRequestId: string;
  try {
    const created = await api.run({ endpointId, input: finalInput });
    falRequestId = created.requestId;
  } catch (err) {
    await replaceImageContent(
      placeholderId,
      makePlaceholderDataUrl(MOTION_RATIO, 'Failed to start', describeFalError(err)),
      'Fal · Failed',
      { x: targetX, y: targetY },
    );
    throw err;
  }

  const settings: GenSettings = {
    endpointId,
    input: finalInput,
    ratio: MOTION_RATIO,
    ...(stickyId ? { sourceStickyId: stickyId } : {}),
    ...(parents.size ? { parents: Array.from(parents) } : {}),
  };
  await addActiveJob({
    requestId: falRequestId,
    endpointId,
    placeholderId,
    targetPosition: { x: targetX, y: targetY },
    kind: 'motion',
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
      makePlaceholderDataUrl(MOTION_RATIO, 'Failed', describeFalError(err)),
      'Fal · Failed',
      { x: targetX, y: targetY },
    );
    await removeActiveJob(falRequestId);
    throw err;
  }

  const outputUrl = final.output?.[0];
  if (final.status === 'SUCCEEDED' && outputUrl) {
    const { width, height } = parseRatio(MOTION_RATIO, 720);
    const abs = await resolveAbsolutePosition(placeholderId);
    const x = abs?.absoluteX ?? targetX;
    const y = abs?.absoluteY ?? targetY;
    await deleteItem(placeholderId);
    const embed = await createEmbedAtPosition({ url: motionEmbedUrl(outputUrl), x, y, width, height });
    settings.costUSD = await estimateCostUSD(endpointId, { units: 1 });
    await setItemGenerationSettings(embed.id, settings);
    await removeActiveJob(falRequestId);
    return { requestId: falRequestId, embedItemId: embed.id, outputUrl };
  }

  await replaceImageContent(
    placeholderId,
    makePlaceholderDataUrl(MOTION_RATIO, 'Failed', final.error),
    `Fal · ${final.status}`,
    { x: targetX, y: targetY },
  );
  await removeActiveJob(falRequestId);
  throw new Error(
    final.error ?? `Motion generation ${final.status}${outputUrl ? '' : ' (no animation returned)'}`,
  );
}
