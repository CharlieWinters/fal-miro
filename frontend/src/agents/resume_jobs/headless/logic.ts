import { api, videoEmbedUrl, model3dEmbedUrl, panoramaEmbedUrl, rigEmbedUrl, type StatusResponse } from '../../../lib/api';
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
  removeActiveJob,
  setItemGenerationSettings,
  type ActiveJob,
} from '../../../shared/storage';
import { extractAnimations, extractRestPose } from '../../../shared/meshyAnimations';
import { estimateCostUSD, reportedInferenceSeconds } from '../../../shared/cost';
import { placeGenericOutput } from '../../../shared/genericOutput';
import { advancePipelineForJob } from '../../../shared/pipelineRunner';

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
    try {
      const s = await api.getStatus(job.endpointId, job.requestId);
      if (isTerminal(s.status)) {
        await finalize(job, s);
        finalized += 1;
      } else {
        void pollUntilDone(job).catch((e) =>
          console.warn(`[resume_jobs] poll failed for ${job.requestId}:`, e),
        );
      }
    } catch (e) {
      console.warn(`[resume_jobs] could not check request ${job.requestId}:`, e);
    }
  }

  return { resumed: jobs.length, finalized };
}

function isTerminal(status: StatusResponse['status']): boolean {
  return status === 'SUCCEEDED' || status === 'FAILED' || status === 'UNKNOWN';
}

async function finalize(job: ActiveJob, s: StatusResponse): Promise<void> {
  // Pipeline steps hand off to the shared advance logic instead of the normal
  // single-model placement below — it's the same function the live pipeline
  // loop calls after a foreground poll, so a reload can't behave differently
  // from what would have happened had the board stayed open.
  if (await advancePipelineForJob(job, s)) return;

  const pos = job.targetPosition;
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
        await setItemGenerationSettings(embed.id, { ...settings, animations: [clip] });
      }
    } else if (job.kind === 'video' || job.kind === 'model3d' || job.kind === 'panorama') {
      // Swap the placeholder image for an inline embed (video player, 3D
      // viewer, or 360 photosphere — same as the live agents).
      const { width, height } = parseRatio(job.settings.ratio, 720);
      const abs = await resolveAbsolutePosition(job.placeholderId);
      const x = abs?.absoluteX ?? pos?.x ?? 0;
      const y = abs?.absoluteY ?? pos?.y ?? 0;
      await deleteItem(job.placeholderId);
      const embedUrl =
        job.kind === 'model3d' ? model3dEmbedUrl(outputUrl) : job.kind === 'panorama' ? panoramaEmbedUrl(outputUrl) : videoEmbedUrl(outputUrl);
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

async function pollUntilDone(
  job: ActiveJob,
  intervalMs = 5000,
  timeoutMs = 15 * 60 * 1000,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const s = await api.getStatus(job.endpointId, job.requestId);
    if (isTerminal(s.status)) {
      await finalize(job, s);
      return;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  console.warn(`[resume_jobs] request ${job.requestId} still pending after timeout`);
}
