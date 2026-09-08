import type { StatusResponse } from '../../../lib/api';
import { PIPELINE_APPS } from '../../../shared/pipelineApps';
import { getPipelineRuns, type ActiveJob } from '../../../shared/storage';
import {
  advancePipelineForJob,
  createPipelineRun,
  findPipelineStepJob,
  startPipelineStep,
} from '../../../shared/pipelineRunner';
import { broadcastUpdate } from '../../../headless/communications';
import { POLL_BUDGET, pollStatus as sharedPollStatus, shouldLeaveForResume as isTimeout } from '../../../shared/pollStatus';

// Polling lives in shared/pollStatus; this agent only chooses its budget.
const pollStatus = (endpointId: string, requestId: string, onTick: (s: StatusResponse) => void) =>
  sharedPollStatus(endpointId, requestId, onTick, POLL_BUDGET.generic);


export type RunPipelinePayload = {
  /** Key into PIPELINE_APPS. */
  appId: string;
  /** The run's fixed (non-chained) inputs — e.g. images the user picked. */
  fixedInputs: Record<string, unknown>;
};

export type RunPipelineResult = {
  runId: string;
  status: 'succeeded';
};

/**
 * Drives a pipeline app's steps to completion while the board tab stays open.
 * Only ever starts step 0 directly — every step after that is started by
 * advancePipelineForJob (the same function resume_jobs calls after a reload),
 * so this loop just has to keep polling whichever step is currently running
 * and hand its result to that one shared function.
 */
export async function run(payload: unknown, requestId = ''): Promise<RunPipelineResult> {
  const { appId, fixedInputs = {} } = (payload ?? {}) as RunPipelinePayload;
  const def = PIPELINE_APPS[appId];
  if (!appId || !def) throw new Error(`Unknown pipeline app: ${appId}`);

  let run = await createPipelineRun(appId, fixedInputs);
  let job: ActiveJob = await startPipelineStep(run, 0, []);

  for (let i = 0; i < def.steps.length; i++) {
    broadcastUpdate({
      requestId,
      status: 'running',
      message: `Step ${i + 1} of ${def.steps.length}: ${def.steps[i].label}`,
    });

    let status: StatusResponse;
    try {
      status = await pollStatus(job.endpointId, job.requestId, (s) => {
        broadcastUpdate({
          requestId,
          status: 'running',
          message: `Step ${i + 1} of ${def.steps.length}: Fal ${s.status.toLowerCase()}…`,
        });
      });
    } catch (err) {
      if (isTimeout(err)) {
        // Still running past our poll window — leave the step's ActiveJob
        // entry in place. resume_jobs's boot sweep will finalize/advance it
        // whenever it actually completes, same as a single-model job that
        // outlives a live poll.
        broadcastUpdate({
          requestId,
          status: 'failed',
          message: 'Still running — it will finish in the background. Reopen the board to collect it.',
        });
      }
      throw err;
    }

    await advancePipelineForJob(job, status);

    if (status.status !== 'SUCCEEDED') {
      throw new Error(`Step ${i + 1} of ${def.steps.length} (${job.endpointId}) ${status.status}`);
    }

    const refreshed = (await getPipelineRuns()).find((r) => r.id === run.id);
    if (!refreshed) break;
    run = refreshed;

    const nextIndex = i + 1;
    if (nextIndex >= def.steps.length) break;
    const nextJob = await findPipelineStepJob(run.id, nextIndex);
    if (!nextJob) break; // shouldn't happen — advancePipelineForJob just started it
    job = nextJob;
  }

  return { runId: run.id, status: 'succeeded' };
}


