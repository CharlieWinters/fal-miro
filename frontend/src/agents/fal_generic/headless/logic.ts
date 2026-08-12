import { api, type StatusResponse } from '../../../lib/api';
import {
  createImageAtAbsolute,
  createImageBelow,
  getImageAspectRatio,
  getImageRef,
  getVideoRef,
  makePlaceholderDataUrl,
  replaceImageContent,
  resolveAbsolutePosition,
  resolveBelowFrameBox,
  resolvePlaceholderAnchor,
  snapFrameRatio,
} from '../../../shared/boardHelpers';
import {
  addActiveJob,
  removeActiveJob,
  setItemGenerationSettings,
  type GenSettings,
} from '../../../shared/storage';
import { placeGenericOutput, type OutputKind } from '../../../shared/genericOutput';
import { estimateCostUSD, reportedInferenceSeconds } from '../../../shared/cost';
import { parseFalInputSchema, pickAspectRatioField } from '../../../shared/schema';
import { broadcastUpdate } from '../../../headless/communications';

/**
 * The catch-all agent: runs any Fal endpoint from a schema-built input and
 * places whatever comes back on the board (image / video / 3D / link). Used by
 * the generic model screen for models without a bespoke agent.
 */
export type GenericGenPayload = {
  endpointId: string;
  /** Model arguments built by the panel's schema form (prompt already filled). */
  input: Record<string, unknown>;
  /** Board images to resolve into named schema fields (URLs, in order). */
  imageFields?: Array<{ field: string; itemIds: string[]; multiple: boolean }>;
  /** Board Fal-video embeds to resolve into named schema fields (URLs, in order). */
  videoFields?: Array<{ field: string; itemIds: string[]; multiple: boolean }>;
  /** Sticky driving the prompt/placement (optional; for lineage). */
  stickyId?: string;
  placeholderRatio?: string;
  /** The settings card this run was started from, if reopened from one — the
   *  output places beside it instead of below the usual source anchor. */
  cardAnchorId?: string;
  /** The frame the references were collected from, if any — takes placement
   *  priority over `cardAnchorId`: the output goes directly below this frame,
   *  sized to match its width (ratio snapped to the frame's own shape when
   *  it's close to a logical one, see `snapFrameRatio`). */
  referenceFrameId?: string;
};

export type GenericGenResult = {
  requestId: string;
  itemId: string;
  outputUrl: string;
  kind: OutputKind;
};

export async function run(payload: unknown, requestId = ''): Promise<GenericGenResult> {
  const {
    endpointId,
    input = {},
    imageFields = [],
    videoFields = [],
    stickyId,
    placeholderRatio,
    cardAnchorId,
    referenceFrameId,
  } = (payload ?? {}) as GenericGenPayload;

  if (!endpointId) throw new Error('endpointId is required');

  const finalInput: Record<string, unknown> = { ...input };
  const parents = new Set<string>();
  if (stickyId) parents.add(stickyId);
  let anchorId: string | undefined = stickyId;

  // Resolve board images into their schema fields (array or single URL).
  if (imageFields.length) {
    broadcastUpdate({ requestId, status: 'queued', message: 'Reading board images…' });
    for (const f of imageFields) {
      const urls: string[] = [];
      for (const id of f.itemIds) {
        const r = await getImageRef(id);
        if (r) {
          urls.push(r.url);
          parents.add(id);
          if (!anchorId) anchorId = id;
        }
      }
      if (urls.length) finalInput[f.field] = f.multiple ? urls : urls[0];
    }
  }

  // Resolve board Fal-video embeds into their schema fields (array or single URL).
  if (videoFields.length) {
    broadcastUpdate({ requestId, status: 'queued', message: 'Reading board videos…' });
    for (const f of videoFields) {
      const urls: string[] = [];
      for (const id of f.itemIds) {
        const r = await getVideoRef(id);
        if (r) {
          urls.push(r.url);
          parents.add(id);
          if (!anchorId) anchorId = id;
        }
      }
      if (urls.length) finalInput[f.field] = f.multiple ? urls : urls[0];
    }
  }

  let ratio = placeholderRatio;
  if (!ratio && anchorId) ratio = (await getImageAspectRatio(anchorId)) ?? undefined;
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
          console.warn('[fal_generic] aspect-ratio override failed', e);
        }
      }
      placementBox = await resolveBelowFrameBox(referenceFrameId, ratio);
    }
  }

  broadcastUpdate({ requestId, status: 'queued', message: 'Placing placeholder…' });
  let placeholderId: string, targetX: number, targetY: number;
  if (placementBox) {
    const placed = await createImageAtAbsolute({
      url: makePlaceholderDataUrl(ratio, 'Generating…'),
      x: placementBox.x,
      y: placementBox.y,
      width: placementBox.width,
      title: 'Fal · Generating',
    });
    placeholderId = placed.id;
    targetX = placed.x;
    targetY = placed.y;
  } else {
    const { anchorId: placementAnchor, side } = await resolvePlaceholderAnchor(cardAnchorId, anchorId);
    const placed = await createImageBelow({
      sourceItemId: placementAnchor,
      url: makePlaceholderDataUrl(ratio, 'Generating…'),
      ratio,
      side,
      title: 'Fal · Generating',
    });
    placeholderId = placed.id;
    targetX = placed.x;
    targetY = placed.y;
  }

  broadcastUpdate({ requestId, status: 'running', message: 'Submitting to Fal…' });
  let falRequestId: string;
  try {
    const created = await api.run({ endpointId, input: finalInput });
    falRequestId = created.requestId;
  } catch (err) {
    await replaceImageContent(placeholderId, makePlaceholderDataUrl(ratio, 'Failed to start'), 'Fal · Failed', {
      x: targetX,
      y: targetY,
    });
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
    kind: 'generic',
    createdAt: Date.now(),
    settings,
  });

  broadcastUpdate({ requestId, status: 'running', message: 'Queued on Fal…', falRequestId });
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
    if (isTimeout(err)) {
      broadcastUpdate({
        requestId,
        status: 'failed',
        message: 'Still running — it will finish in the background. Reopen the board to collect it.',
      });
      throw err;
    }
    await replaceImageContent(placeholderId, makePlaceholderDataUrl(ratio, 'Failed'), 'Fal · Failed', {
      x: targetX,
      y: targetY,
    });
    await removeActiveJob(falRequestId);
    throw err;
  }

  const outputUrl = final.output?.[0];
  if (final.status === 'SUCCEEDED' && outputUrl) {
    const { itemId, kind } = await placeGenericOutput({
      placeholderId,
      targetPosition: { x: targetX, y: targetY },
      ratio,
      url: outputUrl,
      ...(placementBox ? { size: { width: placementBox.width, height: placementBox.height } } : {}),
    });
    const measured = runStartedAt ? (Date.now() - runStartedAt) / 1000 : undefined;
    settings.costUSD = await estimateCostUSD(endpointId, {
      units: 1,
      seconds: reportedInferenceSeconds(final.data) ?? measured,
    });
    await setItemGenerationSettings(itemId, settings);
    await removeActiveJob(falRequestId);
    return { requestId: falRequestId, itemId, outputUrl, kind };
  }

  await replaceImageContent(placeholderId, makePlaceholderDataUrl(ratio, 'Failed'), `Fal · ${final.status}`, {
    x: targetX,
    y: targetY,
  });
  await removeActiveJob(falRequestId);
  throw new Error(`Generation ${final.status}${outputUrl ? '' : ' (no output returned)'}`);
}

function isTimeout(err: unknown): boolean {
  return err instanceof Error && err.name === 'PollTimeout';
}

async function pollStatus(
  endpointId: string,
  fid: string,
  onTick: (s: StatusResponse) => void,
  intervalMs = 4000,
  timeoutMs = 10 * 60 * 1000,
): Promise<StatusResponse> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const s = await api.getStatus(endpointId, fid);
    onTick(s);
    if (s.status === 'SUCCEEDED' || s.status === 'FAILED' || s.status === 'UNKNOWN') return s;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  const err = new Error(`Request ${fid} timed out after ${timeoutMs / 1000}s`);
  err.name = 'PollTimeout';
  throw err;
}
