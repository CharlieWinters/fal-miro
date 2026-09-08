// The one status poller every agent uses.
//
// Polling is not per-workload behaviour: it is the same loop everywhere, and
// the only thing that differs between agents is how long a job is allowed to
// take. Agents pass those numbers in; the loop itself lives here so a fix to
// how errors are handled lands in every agent at once.
//
// Two kinds of outcome that are NOT a failure of the generation:
//
//   - PollTimeout: the job is still running past the agent's budget. The
//     caller should leave the placeholder and the ledger entry alone so
//     resume_jobs can collect the result on the next board load.
//   - PollUnreachable: the status endpoint kept erroring (backend down, network
//     gone, rate-limited). Same treatment — the job may well be fine on Fal.
//
// A FAILED status, by contrast, is terminal and is *returned*, not thrown, so
// callers see it as a result and can clean up. The backend maps Fal-side
// rejections (a 422 on a request, no media generated) to that status rather
// than to an HTTP error, precisely so this loop can tell the two apart.

import { api, type StatusResponse } from '../lib/api';

export type PollOptions = {
  intervalMs?: number;
  timeoutMs?: number;
  /** Consecutive transport errors tolerated before giving up. */
  maxConsecutiveErrors?: number;
  /** Test seam. */
  getStatus?: (endpointId: string, requestId: string) => Promise<StatusResponse>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

export const POLL_DEFAULTS = {
  intervalMs: 4000,
  timeoutMs: 10 * 60 * 1000,
  maxConsecutiveErrors: 5,
};

/** Per-workload budgets. Agents reference these rather than inventing constants. */
export const POLL_BUDGET = {
  image: { intervalMs: 4000, timeoutMs: 10 * 60 * 1000 },
  video: { intervalMs: 5000, timeoutMs: 15 * 60 * 1000 },
  model3d: { intervalMs: 4000, timeoutMs: 20 * 60 * 1000 },
  rig: { intervalMs: 5000, timeoutMs: 20 * 60 * 1000 },
  // Hunyuan World's world-gen is slow — give it plenty of headroom.
  panorama: { intervalMs: 5000, timeoutMs: 30 * 60 * 1000 },
  merge: { intervalMs: 4000, timeoutMs: 15 * 60 * 1000 },
  // Anything at all can come through the generic screen, video and 3D
  // included, so it gets the longest ordinary budget rather than the shortest.
  generic: { intervalMs: 4000, timeoutMs: 20 * 60 * 1000 },
} as const;

export function isTerminal(status: string | undefined): boolean {
  return status === 'SUCCEEDED' || status === 'FAILED' || status === 'UNKNOWN';
}

/** Not a failure: the job may still complete, leave it for resume_jobs. */
export function shouldLeaveForResume(err: unknown): boolean {
  return err instanceof Error && (err.name === 'PollTimeout' || err.name === 'PollUnreachable');
}

export async function pollStatus(
  endpointId: string,
  requestId: string,
  onTick?: (s: StatusResponse) => void,
  opts: PollOptions = {},
): Promise<StatusResponse> {
  const intervalMs = opts.intervalMs ?? POLL_DEFAULTS.intervalMs;
  const timeoutMs = opts.timeoutMs ?? POLL_DEFAULTS.timeoutMs;
  const maxErrors = opts.maxConsecutiveErrors ?? POLL_DEFAULTS.maxConsecutiveErrors;
  const getStatus = opts.getStatus ?? api.getStatus;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;

  const started = now();
  let consecutiveErrors = 0;
  let lastError: unknown = null;

  while (now() - started < timeoutMs) {
    let s: StatusResponse;
    try {
      s = await getStatus(endpointId, requestId);
      consecutiveErrors = 0;
    } catch (err) {
      consecutiveErrors += 1;
      lastError = err;
      if (consecutiveErrors >= maxErrors) {
        const e = new Error(
          `Could not reach the status endpoint for ${requestId} (${consecutiveErrors} attempts): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        e.name = 'PollUnreachable';
        throw e;
      }
      // Back off on errors (2x per attempt, capped) with a little jitter so a
      // fleet of tabs does not hammer a recovering backend in lockstep.
      const backoff = Math.min(intervalMs * 2 ** consecutiveErrors, 30_000);
      await sleep(backoff + Math.floor(Math.random() * 500));
      continue;
    }
    onTick?.(s);
    if (isTerminal(s.status)) return s;
    await sleep(intervalMs);
  }

  const err = new Error(
    `Request ${requestId} timed out after ${Math.round(timeoutMs / 1000)}s` +
      (lastError ? ` (last error: ${lastError instanceof Error ? lastError.message : String(lastError)})` : ''),
  );
  err.name = 'PollTimeout';
  throw err;
}
