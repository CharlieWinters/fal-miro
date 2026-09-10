// When to ask again about a job whose status check threw, and when to stop.
//
// A *throwing* status check tells you nothing about the generation: the backend
// may be briefly down, the network may have gone, or Fal may never have
// accepted the request at all. Retrying is therefore right — but retrying
// forever is not. Before this policy existed, resume_jobs caught the error,
// logged it, and left the ledger entry untouched, so a job that could never
// answer was re-checked on every board load for the life of the board and its
// placeholder said "Generating…" permanently.
//
// So: back off between attempts, and retire the job once it is either out of
// attempts or so old that its own agent's budget has long since passed.
//
// pollStatus.ts owns the *within-session* backoff (it doubles its interval on
// consecutive transport errors). This module owns the *across-session* one.

import { POLL_BUDGET } from '../../shared/pollStatus';
import type { ActiveJob } from '../../shared/storage';

/** Consecutive failed board-load checks before a job is retired. With the
 *  backoff below, eight attempts span roughly two hours of board loads. */
export const MAX_RESUME_ATTEMPTS = 8;

const BACKOFF_BASE_MS = 30_000;
const BACKOFF_CAP_MS = 60 * 60 * 1000;

/** How far past its own agent's timeout a job is still worth asking about.
 *  Fal queues can run long, so allow generous headroom before calling it dead. */
export const AGE_GRACE_MULTIPLIER = 3;

/** The same budget the job's own agent would have given it. */
export function budgetFor(kind: ActiveJob['kind']) {
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
    default:
      return POLL_BUDGET.generic;
  }
}

/** Exponential, capped, with jitter so every open tab does not come back at the
 *  same instant and re-flatten a recovering backend. */
export function nextRetryDelayMs(attempts: number, rand: () => number = Math.random): number {
  const exp = Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1), BACKOFF_CAP_MS);
  return exp + Math.floor(rand() * 1000);
}

/** Is it too early to ask about this job again? */
export function isBackingOff(job: Pick<ActiveJob, 'nextRetryAt'>, now: number): boolean {
  return typeof job.nextRetryAt === 'number' && job.nextRetryAt > now;
}

/** Out of attempts, or old enough that no answer is coming. */
export function isResumeExhausted(
  job: Pick<ActiveJob, 'kind' | 'createdAt'>,
  attempts: number,
  now: number,
): boolean {
  if (attempts >= MAX_RESUME_ATTEMPTS) return true;
  if (typeof job.createdAt !== 'number') return false;
  return now - job.createdAt > budgetFor(job.kind).timeoutMs * AGE_GRACE_MULTIPLIER;
}
