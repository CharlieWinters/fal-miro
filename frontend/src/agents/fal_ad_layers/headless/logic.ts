import { api, type StatusResponse } from '../../../lib/api';
import {
  createImageAtAbsolute,
  getImageRef,
  makePlaceholderDataUrl,
  replaceImageContent,
  resolveAbsolutePosition,
} from '../../../shared/boardHelpers';
import { describeFalError } from '../../../shared/falError';
import { addActiveJob, removeActiveJob, type GenSettings } from '../../../shared/storage';
import { broadcastUpdate } from '../../../headless/communications';
import { POLL_BUDGET, pollStatus as sharedPollStatus, shouldLeaveForResume as isTimeout } from '../../../shared/pollStatus';
import { AD_DEFAULT_WIDTH, buildAdLayersFromResult, isAdLayersResult } from '../../../shared/adLayers';

// Polling lives in shared/pollStatus; this agent only chooses its budget.
const pollStatus = (endpointId: string, requestId: string, onTick: (s: StatusResponse) => void) =>
  sharedPollStatus(endpointId, requestId, onTick, POLL_BUDGET.layers);

/** Gap between the source ad and the rebuilt layers, in board units. */
const GAP = 120;

export type AdLayersPayload = {
  endpointId: string;
  /** The flat ad on the board to take apart. */
  sourceImageId: string;
  /** Model input — `{ text_mode: 'font' | 'svg' }`; image_url is filled in here. */
  input?: Record<string, unknown>;
};

export type AdLayersJobResult = {
  requestId: string;
  /** The rebuilt layers, back to front. */
  itemIds: string[];
  built: number;
  skipped: number;
  summary: string;
  notes: string[];
};

/**
 * Flat ad → editable board items (Bria Ad Delayer).
 *
 * Unlike every other agent here, the model returns no media URL at all: the
 * result *is* the JSON describing the ad's layers, so this reads `data` rather
 * than `output` and rebuilds the ad out of board items below the original (see
 * shared/adLayers.ts). The same builder runs on resume, so a reload
 * mid-generation lands in the same place.
 */
export async function run(payload: unknown, requestId = ''): Promise<AdLayersJobResult> {
  const { endpointId, sourceImageId, input = {} } = (payload ?? {}) as AdLayersPayload;
  if (!endpointId) throw new Error('endpointId is required');
  if (!sourceImageId) throw new Error('Select the flat ad image on the board first.');

  broadcastUpdate({ requestId, status: 'queued', message: 'Reading the ad…' });
  const ref = await getImageRef(sourceImageId);
  if (!ref?.url) throw new Error("Couldn't read that image — try a different one.");
  const finalInput: Record<string, unknown> = { ...input, image_url: ref.url };

  // The layers are rebuilt at the source ad's own size, directly below it, so
  // the two read as a before and after. The ad's canvas has the same aspect as
  // the image, so the placeholder can already be the exact size and place the
  // assembly will occupy.
  const src = await resolveAbsolutePosition(sourceImageId);
  const width = src?.width && src.width > 0 ? src.width : AD_DEFAULT_WIDTH;
  const height = src?.height && src.height > 0 ? src.height : width;
  const ratio = `${Math.round(width)}:${Math.round(height)}`;
  const x = src?.absoluteX ?? 0;
  const y = (src?.absoluteY ?? 0) + height / 2 + GAP + height / 2;

  broadcastUpdate({ requestId, status: 'queued', message: 'Placing placeholder…' });
  const placeholder = await createImageAtAbsolute({
    url: makePlaceholderDataUrl(ratio, 'Splitting into layers…'),
    x,
    y,
    width,
    title: 'Fal · Splitting into layers',
  });

  broadcastUpdate({ requestId, status: 'running', message: 'Submitting to Fal…' });
  let falRequestId: string;
  try {
    const created = await api.run({ endpointId, input: finalInput });
    falRequestId = created.requestId;
  } catch (err) {
    await replaceImageContent(placeholder.id, makePlaceholderDataUrl(ratio, 'Failed to start', describeFalError(err)), 'Fal · Failed', { x, y });
    throw err;
  }

  const settings: GenSettings = {
    endpointId,
    input: finalInput,
    ratio,
    parents: [sourceImageId],
  };
  await addActiveJob({
    requestId: falRequestId,
    endpointId,
    placeholderId: placeholder.id,
    targetPosition: { x, y },
    kind: 'layers',
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
        message: 'Still working — it will finish in the background. Reopen the board to collect it.',
      });
      throw err;
    }
    await replaceImageContent(placeholder.id, makePlaceholderDataUrl(ratio, 'Failed', describeFalError(err)), 'Fal · Failed', { x, y });
    await removeActiveJob(falRequestId);
    throw err;
  }

  if (final.status === 'SUCCEEDED' && isAdLayersResult(final.data)) {
    broadcastUpdate({ requestId, status: 'running', message: 'Rebuilding the ad on the board…' });
    const built = await buildAdLayersFromResult({
      data: final.data,
      settings,
      endpointId,
      placeholderId: placeholder.id,
      targetWidth: width,
      sourceTitle: ref.title,
      sourceImageId,
      x,
      y,
    });
    broadcastUpdate({
      requestId,
      status: 'running',
      message: `Rebuilt ${built.summary}${built.skipped ? ` · ${built.skipped} layer(s) skipped` : ''}`,
    });
    broadcastUpdate({
      requestId,
      status: 'running',
      message: `Rebuilt ${built.summary}${built.skipped ? ` · ${built.skipped} layer(s) skipped` : ''}`,
    });
    await removeActiveJob(falRequestId);
    return { requestId: falRequestId, ...built };
  }

  await replaceImageContent(
    placeholder.id,
    // No error object on this path — the job finished, it just finished badly,
    // so the reason is whatever Fal put on the result.
    makePlaceholderDataUrl(ratio, 'Failed', final.error ?? undefined),
    `Fal · ${final.status}`,
    { x, y },
  );
  await removeActiveJob(falRequestId);
  throw new Error(
    final.error ??
      (final.status === 'SUCCEEDED'
        ? 'The model returned no layers for that image — it expects a flat ad (product, copy, logo).'
        : `Ad split ${final.status}`),
  );
}

