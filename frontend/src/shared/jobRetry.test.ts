import { describe, expect, it } from 'vitest';
import { MAX_JOB_AGE_MS, MAX_JOB_FAILURES, describeGiveUp, giveUpReason } from './jobRetry';

const NOW = 1_800_000_000_000;

describe('giveUpReason', () => {
  it('keeps resuming a fresh job that has not failed', () => {
    expect(giveUpReason({ createdAt: NOW - 60_000 }, NOW)).toBeNull();
    expect(giveUpReason({ createdAt: NOW - 60_000, failures: 0 }, NOW)).toBeNull();
  });

  it('keeps resuming while the job still has failures in hand', () => {
    for (let f = 1; f < MAX_JOB_FAILURES; f++)
      expect(giveUpReason({ createdAt: NOW, failures: f }, NOW), `after ${f}`).toBeNull();
  });

  it('gives up once the failure budget is spent', () => {
    expect(giveUpReason({ createdAt: NOW, failures: MAX_JOB_FAILURES }, NOW)).toBe('unanswerable');
    expect(giveUpReason({ createdAt: NOW, failures: MAX_JOB_FAILURES + 5 }, NOW)).toBe('unanswerable');
  });

  it('gives up on a job older than the age limit even if it never errored', () => {
    // A generation that keeps timing out never counts a failure, so age is the
    // only thing that stops it resuming on every board load.
    expect(giveUpReason({ createdAt: NOW - MAX_JOB_AGE_MS - 1 }, NOW)).toBe('stale');
    expect(giveUpReason({ createdAt: NOW - MAX_JOB_AGE_MS + 1 }, NOW)).toBeNull();
  });

  it('ignores a missing or nonsense createdAt rather than dropping the job', () => {
    for (const createdAt of [0, NaN, undefined as unknown as number, -1])
      expect(giveUpReason({ createdAt }, NOW), String(createdAt)).toBeNull();
  });

  it('reports failures ahead of age when both apply', () => {
    expect(giveUpReason({ createdAt: NOW - MAX_JOB_AGE_MS - 1, failures: MAX_JOB_FAILURES }, NOW)).toBe(
      'unanswerable',
    );
  });

  it('defaults its clock to now', () => {
    expect(giveUpReason({ createdAt: Date.now() })).toBeNull();
    expect(giveUpReason({ createdAt: Date.now() - MAX_JOB_AGE_MS - 1000 })).toBe('stale');
  });
});

describe('describeGiveUp', () => {
  it('says which limit was hit, in terms a board title can carry', () => {
    expect(describeGiveUp('unanswerable')).toBe(`Gave up after ${MAX_JOB_FAILURES} failed status checks`);
    expect(describeGiveUp('stale')).toBe('Gave up after 24h');
  });
});
