import { api, rigEmbedUrl, type StatusResponse } from '../../../lib/api';
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
import { extractAnimations, extractRestPose } from '../../../shared/meshyAnimations';
import { broadcastUpdate } from '../../../headless/communications';

export type RigPayload = {
  endpointId: string;
  /** Model input: { model_url, animation_action_ids, ... } built by the panel. */
  input: Record<string, unknown>;
  /** The source 3D-viewer embed — anchors placement/ratio + lineage. */
  anchorItemId?: string;
  parents?: string[];
  /** Optionally clean the mesh (Meshy Remesh → quad) before rigging — Meshy
   *  recommends this for better skinning/deformation on raw AI meshes. */
  remesh?: { polycount: number };
};

const REMESH_ENDPOINT = 'fal-ai/meshy/v5/remesh';

export type RigResult = {
  requestId: string;
  embedItemId: string;
  outputUrl: string;
};

export async function run(payload: unknown, requestId = ''): Promise<RigResult> {
  const { endpointId, input = {}, anchorItemId, parents = [], remesh } = (payload ?? {}) as RigPayload;

  if (!endpointId) throw new Error('endpointId is required');
  if (!input.model_url) throw new Error('Select a 3D model on the board to rig.');

  let ratio = anchorItemId ? (await getImageAspectRatio(anchorItemId)) ?? undefined : undefined;
  if (!ratio) ratio = '1:1';

  broadcastUpdate({ requestId, status: 'queued', message: 'Placing placeholder…' });
  const { id: placeholderId, x: targetX, y: targetY } = await createImageBelow({
    sourceItemId: anchorItemId,
    url: makePlaceholderDataUrl(ratio, remesh ? 'Preparing mesh…' : 'Rigging character…'),
    ratio,
    title: 'Fal · Rigging',
  });

  const finalInput: Record<string, unknown> = { ...input };
  let remeshCost: number | undefined;

  // Optional remesh → quad before rigging (Meshy's recommended flow for cleaner
  // deformation). Runs inline; only the rig job goes in the resume ledger.
  if (remesh) {
    broadcastUpdate({ requestId, status: 'running', message: 'Cleaning up mesh (remesh → quad)…' });
    try {
      const rm = await api.run({
        endpointId: REMESH_ENDPOINT,
        input: { model_url: finalInput.model_url, topology: 'quad', target_polycount: remesh.polycount },
      });
      const rmFinal = await pollStatus(REMESH_ENDPOINT, rm.requestId, (s) =>
        broadcastUpdate({ requestId, status: 'running', message: `Remeshing… (${s.status.toLowerCase()})` }),
      );
      const remeshedUrl = rmFinal.output?.[0];
      if (rmFinal.status !== 'SUCCEEDED' || !remeshedUrl) {
        throw new Error(`Remesh ${rmFinal.status}${remeshedUrl ? '' : ' (no mesh returned)'}`);
      }
      finalInput.model_url = remeshedUrl;
      remeshCost = await estimateCost(REMESH_ENDPOINT, 1);
    } catch (err) {
      await replaceImageContent(placeholderId, makePlaceholderDataUrl(ratio, 'Remesh failed'), 'Fal · Failed', {
        x: targetX,
        y: targetY,
      });
      throw err;
    }
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
    ...(parents.length ? { parents } : {}),
  };
  await addActiveJob({
    requestId: falRequestId,
    endpointId,
    placeholderId,
    targetPosition: { x: targetX, y: targetY },
    kind: 'rig',
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
        message: 'Still rigging — it will finish in the background. Reopen the board to collect it.',
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

  const animations = extractAnimations(final.data);
  const primaryUrl = final.output?.[0] ?? animations[0]?.url;
  if (final.status === 'SUCCEEDED' && primaryUrl) {
    const { width, height } = parseRatio(ratio, 720);
    const abs = await resolveAbsolutePosition(placeholderId);
    const baseX = abs?.absoluteX ?? targetX;
    const baseY = abs?.absoluteY ?? targetY;

    await deleteItem(placeholderId);

    const rest = extractRestPose(final.data);
    if (rest) settings.restPoseUrl = rest;
    const rigCost = await estimateCost(endpointId, 1);
    settings.costUSD = rigCost !== undefined || remeshCost !== undefined ? (rigCost ?? 0) + (remeshCost ?? 0) : undefined;

    // One embed per animation clip, laid out in a row — every clip is its own
    // playable board item rather than one embed with a clip-switcher hidden
    // inside the (backend-only) Rig Viewer tool.
    const clips = animations.length ? animations : [{ name: 'Animation', url: primaryUrl }];
    const gapX = 40;
    let firstEmbedId = '';
    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      const x = baseX + i * (width + gapX);
      const embed = await createEmbedAtPosition({ url: rigEmbedUrl(clip.url), x, y: baseY, width, height });
      if (i === 0) firstEmbedId = embed.id;
      // Each embed's settings carry just its own clip (so reopening Rig
      // Viewer / the manual poser on it shows only what's actually there),
      // plus the shared cost/lineage/rest-pose info.
      await setItemGenerationSettings(embed.id, { ...settings, animations: [clip] });
    }

    await removeActiveJob(falRequestId);
    return { requestId: falRequestId, embedItemId: firstEmbedId, outputUrl: primaryUrl };
  }

  await replaceImageContent(placeholderId, makePlaceholderDataUrl(ratio, 'Failed'), `Fal · ${final.status}`, {
    x: targetX,
    y: targetY,
  });
  await removeActiveJob(falRequestId);
  throw new Error(`Rigging ${final.status}${primaryUrl ? '' : ' (no rigged model returned)'}`);
}

function isTimeout(err: unknown): boolean {
  return err instanceof Error && err.name === 'PollTimeout';
}

async function estimateCost(endpointId: string, units: number): Promise<number | undefined> {
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
  intervalMs = 5000,
  timeoutMs = 20 * 60 * 1000,
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
