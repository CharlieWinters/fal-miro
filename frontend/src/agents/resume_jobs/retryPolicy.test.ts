import { describe, expect, it } from 'vitest';

import {
  AGE_GRACE_MULTIPLIER,
  MAX_RESUME_ATTEMPTS,
  budgetFor,
  isBackingOff,
  isResumeExhausted,
  nextRetryDelayMs,
} from './retryPolicy';

describe('nextRetryDelayMs', () => {
  it('doubles per attempt and caps at an hour', () => {
    const noJitter = () => 0;
    expect(nextRetryDelayMs(1, noJitter)).toBe(30_000);
    expect(nextRetryDelayMs(2, noJitter)).toBe(60_000);
    expect(nextRetryDelayMs(3, noJitter)).toBe(120_000);
    expect(nextRetryDelayMs(20, noJitter)).toBe(60 * 60 * 1000);
  });

  it('never goes below the base delay, whatever it is handed', () => {
    const noJitter = () => 0;
    expect(nextRetryDelayMs(0, noJitter)).toBe(30_000);
    expect(nextRetryDelayMs(-5, noJitter)).toBe(30_000);
  });

  it('adds jitter so tabs do not come back in lockstep', () => {
    expect(nextRetryDelayMs(1, () => 0.999)).toBeGreaterThan(nextRetryDelayMs(1, () => 0));
    expect(nextRetryDelayMs(1, () => 0.999)).toBeLessThan(31_000);
  });
});

describe('isBackingOff', () => {
  it('defers only while the retry time is in the future', () => {
    expect(isBackingOff({ nextRetryAt: 2_000 }, 1_000)).toBe(true);
    expect(isBackingOff({ nextRetryAt: 1_000 }, 2_000)).toBe(false);
  });

  it('treats a job with no retry time as due now', () => {
    expect(isBackingOff({}, 1_000)).toBe(false);
    expect(isBackingOff({ nextRetryAt: undefined }, 1_000)).toBe(false);
  });
});

describe('isResumeExhausted', () => {
  const fresh = { kind: 'image' as const, createdAt: 1_000 };

  it('retires a job that has run out of attempts', () => {
    expect(isResumeExhausted(fresh, MAX_RESUME_ATTEMPTS - 1, 1_000)).toBe(false);
    expect(isResumeExhausted(fresh, MAX_RESUME_ATTEMPTS, 1_000)).toBe(true);
  });

  it('retires a job far past its own agent budget, however few the attempts', () => {
    const budget = budgetFor('image').timeoutMs;
    const justInside = 1_000 + budget * AGE_GRACE_MULTIPLIER;
    expect(isResumeExhausted(fresh, 1, justInside)).toBe(false);
    expect(isResumeExhausted(fresh, 1, justInside + 1)).toBe(true);
  });

  it('gives slower workloads correspondingly longer before retirement', () => {
    // A panorama outliving an image's budget is normal, so age alone must not
    // retire it.
    const imageBudget = budgetFor('image').timeoutMs;
    const at = 1_000 + imageBudget * AGE_GRACE_MULTIPLIER + 1;
    expect(isResumeExhausted({ kind: 'panorama', createdAt: 1_000 }, 1, at)).toBe(false);
    expect(budgetFor('panorama').timeoutMs).toBeGreaterThan(imageBudget);
  });

  it('does not retire on age when the job has no createdAt', () => {
    expect(isResumeExhausted({ kind: 'image', createdAt: undefined as unknown as number }, 1, 9e12)).toBe(
      false,
    );
  });
});
