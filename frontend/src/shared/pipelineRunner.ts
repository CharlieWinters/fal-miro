// Pipeline execution — the shared logic behind a multi-model "app" run (see
// pipelineApps.ts). Deliberately mirrors the single-model pattern already
// used everywhere else (fal_generic + resume_jobs): a placeholder goes on the
// board immediately, an ActiveJob tracks the in-flight Fal request, and
// finishing that job places the real result.
//
// The one new idea is `advancePipelineForJob`: given a job that just resolved
// (success or failure), it updates the run's persisted state and — on success
// — starts the next step. It's called from exactly two places: the live poll
// loop in agents/run_pipeline (foreground case) and resume_jobs's boot sweep
// (the user closed and reopened the board mid-pipeline). Both paths do
// "read persisted state → do one thing → persist → return", so a reload
// can't drift from what the live path would have done — there's no separate
// catch-up logic to keep in sync.

import { api, type StatusResponse } from '../lib/api';
import { PIPELINE_APPS } from './pipelineApps';
import {
  addActiveJob,
  addPipelineRun,
  findPipelineRunByRequestId,
  getActiveJobs,
  removeActiveJob,
  updatePipelineRun,
  type ActiveJob,
  type PipelineRun,
} from './storage';
import {
  createImageBelow,
  makePlaceholderDataUrl,
  replaceImageContent,
  resolveAbsolutePosition,
  resolvePlaceholderAnchor,
  snapFrameRatio,
} from './boardHelpers';
import { placeGenericOutput } from './genericOutput';
import { parseFalInputSchema, pickAspectRatioField } from './schema';

const DEFAULT_RATIO = '1:1';

function newRunId(): string {
  return `pl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Start a brand-new pipeline run (all steps pending) and persist it. */
export async function createPipelineRun(appId: string, fixedInputs: Record<string, unknown>): Promise<PipelineRun> {
  const def = PIPELINE_APPS[appId];
  if (!def) throw new Error(`Unknown pipeline app: ${appId}`);
  const run: PipelineRun = {
    id: newRunId(),
    appId,
    boardLayout: def.boardLayout,
    fixedInputs,
    steps: def.steps.map((s) => ({ endpointId: s.endpointId, status: 'pending' })),
    currentStep: 0,
    createdAt: Date.now(),
  };
  await addPipelineRun(run);
  return run;
}

/**
 * Submit one step to Fal: builds its input from the app's step definition,
 * places a placeholder (if the app lays results out on the board), and
 * registers an ActiveJob tagged with this run/step so resume_jobs can pick it
 * back up after a reload. Returns the registered ActiveJob.
 */
export async function startPipelineStep(
  run: PipelineRun,
  stepIndex: number,
  priorOutputs: string[],
): Promise<ActiveJob> {
  const def = PIPELINE_APPS[run.appId];
  const stepDef = def.steps[stepIndex];
  const input = await stepDef.buildInput({ fixedInputs: run.fixedInputs, priorOutputs });

  // A step can name the board item whose shape its output should match (e.g.
  // the sketch for a sketch-to-image step, the model photo for a try-on step)
  // — per-app/per-step choice, but resolving it into an actual ratio (and
  // pushing that into the Fal request, when the model has a field for it) is
  // shared mechanics, same as the frame-anchored placement fal_generic uses.
  const ratioItemId = stepDef.ratioFromItemId?.({ fixedInputs: run.fixedInputs });
  const ratioPos = ratioItemId ? await resolveAbsolutePosition(ratioItemId) : null;
  const ratio = ratioPos?.width && ratioPos?.height ? `${Math.round(ratioPos.width)}:${Math.round(ratioPos.height)}` : DEFAULT_RATIO;

  if (ratioPos?.width && ratioPos?.height) {
    const snapped = snapFrameRatio(ratioPos.width, ratioPos.height);
    if (snapped) {
      try {
        const schemaRes = await api.getSchema(stepDef.endpointId);
        const aspectField = pickAspectRatioField(parseFalInputSchema(schemaRes.openapi));
        const value = aspectField?.valueForRatio(snapped);
        if (aspectField && value) input[aspectField.name] = value;
      } catch (e) {
        console.warn(`[pipelineRunner] aspect-ratio override failed for ${stepDef.endpointId}:`, e);
      }
    }
  }

  let placeholderId: string | undefined;
  let targetPosition: { x: number; y: number } | undefined;
  if (run.boardLayout) {
    const priorAnchor = stepIndex > 0 ? run.steps[stepIndex - 1]?.outputItemId : undefined;
    const { anchorId, side } = await resolvePlaceholderAnchor(undefined, priorAnchor);
    const placed = await createImageBelow({
      sourceItemId: anchorId,
      url: makePlaceholderDataUrl(ratio, 'Generating…'),
      ratio,
      title: `Fal · ${stepDef.label}`,
      side,
    });
    placeholderId = placed.id;
    targetPosition = { x: placed.x, y: placed.y };
  }

  const created = await api.run({ endpointId: stepDef.endpointId, input });

  run.steps[stepIndex] = { ...run.steps[stepIndex], status: 'running', requestId: created.requestId };
  await updatePipelineRun(run.id, { steps: run.steps, currentStep: stepIndex });

  const job: ActiveJob = {
    requestId: created.requestId,
    endpointId: stepDef.endpointId,
    placeholderId: placeholderId ?? '',
    targetPosition,
    kind: 'generic',
    createdAt: Date.now(),
    settings: { endpointId: stepDef.endpointId, input, ratio },
    pipelineRunId: run.id,
    stepIndex,
  };
  // Always tracked in the resumable ledger, even when this app doesn't lay
  // results out on the board — boardLayout only decides whether a step's
  // result gets *placed* anywhere; the underlying Fal job (and the pipeline's
  // ability to survive a closed board and advance to the next step) works
  // the same either way.
  await addActiveJob(job);

  return job;
}

/**
 * A step's Fal job just resolved. Marks it done or failed, places its output
 * on the board if this app lays results out there, and on success starts the
 * next step (or nothing more if this was the last one). Never advances past a
 * failed step, so whatever the prior step already produced stays untouched.
 * Returns false if `job` doesn't belong to a pipeline run (so callers know to
 * fall back to their own normal single-model finalize).
 */
export async function advancePipelineForJob(job: ActiveJob, status: StatusResponse): Promise<boolean> {
  if (!job.pipelineRunId || job.stepIndex == null) return false;
  const found = await findPipelineRunByRequestId(job.requestId);
  if (!found) return false;
  const { run, stepIndex } = found;
  const outputUrl = status.output?.[0];

  if (status.status === 'SUCCEEDED' && outputUrl) {
    let outputItemId = job.placeholderId || undefined;
    if (run.boardLayout && job.placeholderId) {
      const placed = await placeGenericOutput({
        placeholderId: job.placeholderId,
        targetPosition: job.targetPosition,
        ratio: job.settings.ratio,
        url: outputUrl,
      });
      outputItemId = placed.itemId;
    }
    run.steps[stepIndex] = { ...run.steps[stepIndex], status: 'done', outputUrl, outputItemId };
    await updatePipelineRun(run.id, { steps: run.steps });
    await removeActiveJob(job.requestId);

    const def = PIPELINE_APPS[run.appId];
    const nextIndex = stepIndex + 1;
    if (nextIndex < def.steps.length) {
      const priorOutputs = run.steps.slice(0, nextIndex).map((s) => s.outputUrl ?? '');
      await startPipelineStep(run, nextIndex, priorOutputs);
    }
  } else {
    if (run.boardLayout && job.placeholderId) {
      await replaceImageContent(
        job.placeholderId,
        makePlaceholderDataUrl(job.settings.ratio, 'Failed'),
        `Fal · ${status.status}`,
        job.targetPosition,
      );
    }
    run.steps[stepIndex] = { ...run.steps[stepIndex], status: 'failed' };
    await updatePipelineRun(run.id, { steps: run.steps });
    await removeActiveJob(job.requestId);
  }

  return true;
}

/** The ActiveJob currently tracking a run's given step, if any. */
export async function findPipelineStepJob(runId: string, stepIndex: number): Promise<ActiveJob | undefined> {
  const jobs = await getActiveJobs();
  return jobs.find((j) => j.pipelineRunId === runId && j.stepIndex === stepIndex);
}
