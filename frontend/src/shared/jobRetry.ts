// When to stop resuming a job.
//
// A persisted job used to be immortal. resume_jobs asked Fal for its status on
// every board load; if that call threw, it logged a warning and *kept* the
// ledger entry so the next load could try again. Nothing counted the attempts
// and nothing expired an entry by age, so one permanently-broken job retried
// for the life of the board.
//
// Found live: Bria's ad-delayer refuses an image over 800 px per dimension, Fal
// reported that with an HTTP status the backend read as transient, and the job
// came back on every single board load. The backend's classification is fixed
// separately (see terminalStatusFor) — this module is the backstop for every
// other way a job can become unanswerable, including ones we haven't met yet.
//
// Deliberately pure and DOM-free: the rule is the same in the headless frame,
// the panel and a test.

/** Failed status checks tolerated before a job is abandoned. */
export const MAX_JOB_FAILURES = 3;

/**
 * A job older than this is abandoned however it looks. Fal's own results do not
 * live forever, and a job still unresolved a day later is never going to be:
 * without this, a generation that keeps timing out (rather than erroring) would
 * still resume on every load, since a timeout is not counted as a failure.
 */
export const MAX_JOB_AGE_MS = 24 * 60 * 60 * 1000;

/** The parts of a persisted job this decision needs. */
export type JobRetryState = {
  createdAt: number;
  /** Consecutive status checks that could not be answered. */
  failures?: number;
};

export type GiveUpReason = 'unanswerable' | 'stale';

/**
 * Why this job should be dropped from the ledger, or null to keep resuming it.
 * `now` is injectable so callers and tests share one clock.
 */
export function giveUpReason(job: JobRetryState, now: number = Date.now()): GiveUpReason | null {
  if ((job.failures ?? 0) >= MAX_JOB_FAILURES) return 'unanswerable';
  // A createdAt that is missing, zero or NaN would make the age test either
  // meaningless or permanently true; treat it as "no age known" and rely on the
  // failure count instead.
  const createdAt = Number(job.createdAt);
  if (Number.isFinite(createdAt) && createdAt > 0 && now - createdAt > MAX_JOB_AGE_MS) return 'stale';
  return null;
}

/** Short human label for the placeholder title when we give up. */
export function describeGiveUp(reason: GiveUpReason): string {
  return reason === 'stale'
    ? `Gave up after ${Math.round(MAX_JOB_AGE_MS / 3_600_000)}h`
    : `Gave up after ${MAX_JOB_FAILURES} failed status checks`;
}
