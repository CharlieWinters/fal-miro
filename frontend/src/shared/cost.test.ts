import { beforeEach, describe, expect, it, vi } from 'vitest';

const estimate = vi.hoisted(() => vi.fn());
vi.mock('../lib/api', () => ({ api: { estimate } }));

import { estimateCostUSD, reportedInferenceSeconds, resetCostCacheForTests } from './cost';

describe('reportedInferenceSeconds', () => {
  it.each([
    [{ timings: { inference: 12.5 } }, 12.5],
    [{ timing: { inference_time: 3 } }, 3],
    [{ metrics: { total: 7 } }, 7],
    [{ timings: { elapsed: 2 } }, 2],
    [{ timings: { duration: 9 } }, 9],
  ])('reads %j as %d', (data, expected) => {
    expect(reportedInferenceSeconds(data)).toBe(expected);
  });

  it('prefers the inference figure when several are present', () => {
    expect(reportedInferenceSeconds({ timings: { inference: 5, total: 30 } })).toBe(5);
  });

  it.each([[undefined], [null], ['x'], [{}], [{ timings: {} }], [{ timings: { inference: 0 } }], [{ timings: { inference: -1 } }]])(
    'treats %j as absent',
    (data) => {
      expect(reportedInferenceSeconds(data)).toBeUndefined();
    },
  );
});

describe('estimateCostUSD', () => {
  beforeEach(() => {
    estimate.mockReset();
    resetCostCacheForTests();
  });

  it('multiplies the unit price by units for per-output models', async () => {
    estimate.mockResolvedValue({ costUSD: 0.04, unit: 'images', unitPrice: 0.04, perSecond: false });
    expect(await estimateCostUSD('fal-ai/x', { units: 3 })).toBeCloseTo(0.12);
  });

  it('bills time-based models on the reported seconds, not on units', async () => {
    estimate.mockResolvedValue({ costUSD: 0.001, unit: 'seconds', unitPrice: 0.001, perSecond: true });
    expect(await estimateCostUSD('fal-ai/x', { units: 1, seconds: 42 })).toBeCloseTo(0.042);
  });

  it('falls back to units when a time-based model reports no seconds', async () => {
    estimate.mockResolvedValue({ costUSD: 0.5, unit: 'compute seconds', unitPrice: 0.5, perSecond: true });
    expect(await estimateCostUSD('fal-ai/x', { units: 2 })).toBeCloseTo(1);
  });

  it('looks a price up once per endpoint and reuses it', async () => {
    estimate.mockResolvedValue({ costUSD: 0.15, unit: 'images', unitPrice: 0.15, perSecond: false });
    await estimateCostUSD('fal-ai/a');
    await estimateCostUSD('fal-ai/a', { units: 2 });
    await estimateCostUSD('fal-ai/b');
    expect(estimate).toHaveBeenCalledTimes(2);
  });

  it('retries a failed lookup once before giving up', async () => {
    vi.useFakeTimers();
    try {
      estimate.mockRejectedValueOnce(new Error('429')).mockResolvedValueOnce({ unitPrice: 0.02, perSecond: false });
      const p = estimateCostUSD('fal-ai/x');
      await vi.advanceTimersByTimeAsync(2000);
      expect(await p).toBeCloseTo(0.02);
      expect(estimate).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns undefined, and does not cache, when both attempts fail', async () => {
    vi.useFakeTimers();
    try {
      estimate.mockRejectedValue(new Error('429'));
      const p = estimateCostUSD('fal-ai/x');
      await vi.advanceTimersByTimeAsync(2000);
      expect(await p).toBeUndefined();
      estimate.mockResolvedValue({ unitPrice: 0.02, perSecond: false });
      expect(await estimateCostUSD('fal-ai/x')).toBeCloseTo(0.02);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns undefined when Fal has no price for the endpoint', async () => {
    estimate.mockResolvedValue({ costUSD: null, unit: null });
    expect(await estimateCostUSD('fal-ai/x')).toBeUndefined();
  });
});
