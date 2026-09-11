import { api, videoEmbedUrl, model3dEmbedUrl, panoramaEmbedUrl, rigEmbedUrl, motionEmbedUrl, type StatusResponse } from '../../../lib/api';
import { POLL_BUDGET, isTerminal, isUnreachable, pollStatus, shouldLeaveForResume } from '../../../shared/pollStatus';
import { describeGiveUp, giveUpReason } from '../../../shared/jobRetry';
import {
  createEmbedAtPosition,
  deleteItem,
  makePlaceholderDataUrl,
  parseRatio,
  replaceImageContent,
  resolveAbsolutePosition,
} from '../../../shared/boardHelpers';
import {
  getActiveJobs,
  recordJobFailure,
  removeActiveJob,
  resetJobFailures,
  setItemGenerationSettings,
  type ActiveJob,
} from '../../../shared/storage';
import { extractAnimations, extractRestPose } from '../../../shared/meshyAnimations';
import { estimateCostUSD, reportedInferenceSeconds } from '../../../shared/cost';
import { placeGenericOutput } from '../../../shared/genericOutput';
import { advancePipelineForJob } from '../../../shared/pipelineRunner';
import { buildAdLayersFromResult, isAdLayersResult, targetWidthFromRatio } from '../../../shared/adLayers';

/**
 * Walk the persisted active-jobs list and check each one's current status with
 * Fal. Finished jobs are applied to their placeholder and dropped from the
 * list; anything still running re-arms a background poller.
 *
 * Invoked on board load from headless/index.ts, so generations survive the
 * user closing and re-opening the board.
 */
export async function run(_payload: unknown): Promise<{ resumed: number; finalized: number }> {
  const jobs = await getActiveJobs();
  if (jobs.length === 0) return { resumed: 0, finalized: 0 };

  console.log(`[resume_jobs] resuming ${jobs.length} active job(s)`);

  let finalized = 0;
  for (const job of jobs) {
    // Cheapest check first: a job already past its failure budget or its age
    // limit is dropped without spending a status call on it.
    const done = giveUpReason(job);
    if (done) {
      await abandon(job, describeGiveUp(done));
      continue;
    }
    try {
      const s = await api.getStatus(job.endpointId, job.requestId);
      if (isTerminal(s.status)) {
        await finalize(job, s);
        finalized += 1;
      } else {
        await resetJobFailures(job.requestId);
        void pollUntilDone(job).catch((e) =>
          console.warn(`[resume_jobs] poll failed for ${job.requestId}:`, e),
        );
      }
    } catch (e) {
      console.warn(`[resume_jobs] could not check request ${job.requestId}:`, e);
      await noteFailedCheck(job, e);
    }
  }

  return { resumed: jobs.length, finalized };
}

/**
 * Count a status check we could not get an answer to, and abandon the job once
 * it has used up its budget. Without this the entry stays in the ledger and is
 * retried on every board load, for the life of the board.
 */
async function noteFailedCheck(job: ActiveJob, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  const failures = await recordJobFailure(job.requestId, message);
  if (failures === 0) return; // already gone from the ledger
  const reason = giveUpReason({ createdAt: job.createdAt, failures });
  if (reason) await abandon(job, describeGiveUp(reason));
}

/**
 * Stop tracking a job: resolve its placeholder so the board does not keep a
 * frozen "generating" tile, then drop the ledger entry. Placeholder failures
 * are swallowed — the entry must go either way, or we are back to retrying
 * forever.
 */
async function abandon(job: ActiveJob, why: string): Promise<void> {
  console.warn(`[resume_jobs] abandoning ${job.requestId}: ${why}`);
  try {
    await replaceImageContent(
      job.placeholderId,
      makePlaceholderDataUrl(job.settings.ratio, 'Failed'),
      `Fal · ${why}`,
      job.targetPosition,
    );
  } catch (e) {
    console.warn(`[resume_jobs] could not update the placeholder for ${job.requestId}:`, e);
  }
  await removeActiveJob(job.requestId);
}

/** Does the job's placeholder still exist on the board? */
async function placeholderPresent(job: ActiveJob): Promise<boolean> {
  if (!job.placeholderId) return false;
  try {
    return Boolean(await miro.board.getById(job.placeholderId));
  } catch {
    return false;
  }
}

async function finalize(job: ActiveJob, s: StatusResponse): Promise<void> {
  // Pipeline steps hand off to the shared advance logic instead of the normal
  // single-model placement below — it's the same function the live pipeline
  // loop calls after a foreground poll, so a reload can't behave differently
  // from what would have happened had the board stayed open.
  if (await advancePipelineForJob(job, s)) return;

  // The placeholder is the hand-off token. If it is already gone, the live
  // agent finished this job in the moment before the board reloaded (it
  // deletes the placeholder, creates the output, then clears the ledger — a
  // reload between the last two steps lands here). Placing the output again
  // would duplicate it, and throwing would leave the job "resuming…" on every
  // board load forever, so just drop the ledger entry.
  if (!(await placeholderPresent(job))) {
    console.warn(`[resume_jobs] placeholder for ${job.requestId} is gone — assuming it was already finalized`);
    await removeActiveJob(job.requestId);
    return;
  }

  const pos = job.targetPosition;

  // Ad-to-layers is the one job whose result is the payload rather than a
  // media URL, so it is settled before the `outputUrl` checks below — those
  // would read it as a failure. Same builder as the live agent.
  if (job.kind === 'layers') {
    if (s.status === 'SUCCEEDED' && isAdLayersResult(s.data)) {
      await buildAdLayersFromResult({
        data: s.data,
        settings: job.settings,
        endpointId: job.endpointId,
        placeholderId: job.placeholderId,
        // The live agent stored the source ad's board size as the job's ratio.
        targetWidth: targetWidthFromRatio(job.settings.ratio),
        sourceImageId: job.settings.parents?.[0],
        x: pos?.x ?? 0,
        y: pos?.y ?? 0,
      });
    } else {
      await replaceImageContent(
        job.placeholderId,
        makePlaceholderDataUrl(job.settings.ratio, 'Failed'),
        `Fal · ${s.status}`,
        pos,
      );
    }
    await removeActiveJob(job.requestId);
    return;
  }

  const outputUrl = s.output?.[0];
  if (s.status === 'SUCCEEDED' && outputUrl) {
    if (job.kind === 'generic') {
      // Generic job: classify the result and place it (image / video / 3D / link).
      const { itemId } = await placeGenericOutput({
        placeholderId: job.placeholderId,
        targetPosition: pos,
        ratio: job.settings.ratio,
        url: outputUrl,
      });
      const settings = { ...job.settings };
      if (settings.costUSD == null) {
        settings.costUSD = await estimateCostUSD(job.endpointId, {
          units: 1,
          seconds: reportedInferenceSeconds(s.data),
        });
      }
      await setItemGenerationSettings(itemId, settings);
    } else if (job.kind === 'rig') {
      // One embed per animation clip, laid out in a row — mirrors fal_rig's
      // live-path finalize (see its own comment) so a reload can't behave
      // differently from what would have happened had the board stayed open.
      const { width, height } = parseRatio(job.settings.ratio, 720);
      const abs = await resolveAbsolutePosition(job.placeholderId);
      const baseX = abs?.absoluteX ?? pos?.x ?? 0;
      const baseY = abs?.absoluteY ?? pos?.y ?? 0;
      await deleteItem(job.placeholderId);

      const animations = extractAnimations(s.data);
      const settings = { ...job.settings, restPoseUrl: extractRestPose(s.data) ?? undefined };
      if (settings.costUSD == null) {
        settings.costUSD = await estimateCostUSD(job.endpointId, {
          units: 1,
          seconds: reportedInferenceSeconds(s.data),
        });
      }

      const clips = animations.length ? animations : [{ name: 'Animation', url: outputUrl }];
      const gapX = 40;
      for (let i = 0; i < clips.length; i++) {
        const clip = clips[i];
        const x = baseX + i * (width + gapX);
        const embed = await createEmbedAtPosition({ url: rigEmbedUrl(clip.url), x, y: baseY, width, height });
        // Cost on the first clip only, as in fal_rig's live path.
        await setItemGenerationSettings(embed.id, {
          ...settings,
          ...(i > 0 ? { costUSD: undefined } : {}),
          animations: [clip],
        });
      }
    } else if (job.kind === 'video' || job.kind === 'model3d' || job.kind === 'panorama' || job.kind === 'motion') {
      // Swap the placeholder image for an inline embed (video player, 3D
      // viewer, or 360 photosphere — same as the live agents).
      const { width, height } = parseRatio(job.settings.ratio, 720);
      const abs = await resolveAbsolutePosition(job.placeholderId);
      const x = abs?.absoluteX ?? pos?.x ?? 0;
      const y = abs?.absoluteY ?? pos?.y ?? 0;
      await deleteItem(job.placeholderId);
      const embedUrl =
        job.kind === 'model3d'
          ? model3dEmbedUrl(outputUrl)
          : job.kind === 'panorama'
            ? panoramaEmbedUrl(outputUrl)
            : job.kind === 'motion'
              ? motionEmbedUrl(outputUrl)
              : videoEmbedUrl(outputUrl);
      const embed = await createEmbedAtPosition({ url: embedUrl, x, y, width, height });
      const settings = { ...job.settings };
      // Backfill cost if the live agent never got to stamp it (e.g. the job
      // timed out and finished in the background). Time-billed models bill on
      // Fal's reported compute time.
      if (settings.costUSD == null) {
        settings.costUSD = await estimateCostUSD(job.endpointId, {
          units: 1,
          seconds: reportedInferenceSeconds(s.data),
        });
      }
      await setItemGenerationSettings(embed.id, settings);
    } else {
      const name = (job.settings.assetName ?? '').trim();
      await replaceImageContent(job.placeholderId, outputUrl, name || 'Fal · Generated', pos);
      await setItemGenerationSettings(job.placeholderId, job.settings);
    }
  } else {
    await replaceImageContent(
      job.placeholderId,
      makePlaceholderDataUrl(job.settings.ratio, 'Failed'),
      `Fal · ${s.status}`,
      pos,
    );
  }
  await removeActiveJob(job.requestId);
}

/** The same budget the job's own agent would have given it. */
function budgetFor(kind: ActiveJob['kind']) {
  switch (kind) {
    case 'image':
      return POLL_BUDGET.image;
    case 'video':
    case 'audio':
      return POLL_BUDGET.video;
    case 'model3d':
      return POLL_BUDGET.model3d;
    case 'rig':
      return POLL_BUDGET.rig;
    case 'panorama':
      return POLL_BUDGET.panorama;
    case 'motion':
      return POLL_BUDGET.motion;
    case 'layers':
      return POLL_BUDGET.layers;
    default:
      return POLL_BUDGET.generic;
  }
}

async function pollUntilDone(job: ActiveJob): Promise<void> {
  try {
    const s = await pollStatus(job.endpointId, job.requestId, undefined, budgetFor(job.kind));
    await finalize(job, s);
  } catch (err) {
    if (shouldLeaveForResume(err)) {
      // Still running (or the backend is unreachable) — keep the ledger entry
      // so the next board load tries again. An unreachable status taught us
      // nothing about the job, so it counts against the failure budget; a
      // timeout means Fal said the job is alive, so it does not.
      console.warn(`[resume_jobs] request ${job.requestId} left for the next load:`, err);
      if (isUnreachable(err)) await noteFailedCheck(job, err);
      return;
    }
    throw err;
  }
}
