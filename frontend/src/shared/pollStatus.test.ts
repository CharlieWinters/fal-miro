import { describe, expect, it, vi } from 'vitest';
import type { StatusResponse } from '../lib/api';
import { POLL_BUDGET, isTerminal, pollStatus, shouldLeaveForResume } from './pollStatus';

const st = (status: StatusResponse['status'], extra: Partial<StatusResponse> = {}): StatusResponse => ({
  requestId: 'r1',
  endpointId: 'fal-ai/x',
  status,
  ...extra,
});

/** A fake clock: sleep advances time instead of waiting. */
function clock() {
  let t = 0;
  return {
    now: () => t,
    sleep: vi.fn(async (ms: number) => {
      t += ms;
    }),
  };
}

describe('pollStatus', () => {
  it('returns as soon as the status is terminal and reports every tick', async () => {
    const c = clock();
    const seq = [st('QUEUED', { queuePosition: 2 }), st('RUNNING'), st('SUCCEEDED', { output: ['u'] })];
    const getStatus = vi.fn(async () => seq.shift()!);
    const ticks: string[] = [];
    const out = await pollStatus('fal-ai/x', 'r1', (s) => ticks.push(s.status), { ...c, getStatus, intervalMs: 100 });
    expect(out.status).toBe('SUCCEEDED');
    expect(ticks).toEqual(['QUEUED', 'RUNNING', 'SUCCEEDED']);
    expect(getStatus).toHaveBeenCalledTimes(3);
  });

  it('returns FAILED as a result rather than throwing', async () => {
    const c = clock();
    const getStatus = vi.fn(async () => st('FAILED', { error: 'no media generated' }));
    const out = await pollStatus('fal-ai/x', 'r1', undefined, { ...c, getStatus });
    expect(out.status).toBe('FAILED');
    expect(out.error).toBe('no media generated');
  });

  it('rides through transient errors and succeeds', async () => {
    const c = clock();
    let n = 0;
    const getStatus = vi.fn(async () => {
      n += 1;
      if (n <= 2) throw new Error('502 Bad Gateway');
      return st('SUCCEEDED');
    });
    const out = await pollStatus('fal-ai/x', 'r1', undefined, { ...c, getStatus, intervalMs: 100 });
    expect(out.status).toBe('SUCCEEDED');
    expect(getStatus).toHaveBeenCalledTimes(3);
    // Backed off between the failed attempts rather than sleeping the plain interval.
    expect(c.sleep.mock.calls[0][0]).toBeGreaterThanOrEqual(200);
  });

  it('gives up with PollUnreachable after repeated errors, not with a failure', async () => {
    const c = clock();
    const getStatus = vi.fn(async () => {
      throw new Error('fetch failed');
    });
    const p = pollStatus('fal-ai/x', 'r1', undefined, { ...c, getStatus, maxConsecutiveErrors: 3 });
    await expect(p).rejects.toMatchObject({ name: 'PollUnreachable' });
    expect(getStatus).toHaveBeenCalledTimes(3);
  });

  it('throws PollTimeout when the budget runs out', async () => {
    const c = clock();
    const getStatus = vi.fn(async () => st('RUNNING'));
    const p = pollStatus('fal-ai/x', 'r1', undefined, { ...c, getStatus, intervalMs: 1000, timeoutMs: 3500 });
    await expect(p).rejects.toMatchObject({ name: 'PollTimeout' });
    expect(getStatus).toHaveBeenCalledTimes(4);
  });

  it('resets the error count after a good response', async () => {
    const c = clock();
    const seq = ['err', 'err', 'ok', 'err', 'err', 'done'];
    const getStatus = vi.fn(async () => {
      const step = seq.shift();
      if (step === 'err') throw new Error('blip');
      return step === 'done' ? st('SUCCEEDED') : st('RUNNING');
    });
    const out = await pollStatus('fal-ai/x', 'r1', undefined, { ...c, getStatus, maxConsecutiveErrors: 3 });
    expect(out.status).toBe('SUCCEEDED');
  });
});

describe('helpers', () => {
  it('knows which statuses end a poll', () => {
    expect(isTerminal('SUCCEEDED')).toBe(true);
    expect(isTerminal('FAILED')).toBe(true);
    expect(isTerminal('UNKNOWN')).toBe(true);
    expect(isTerminal('RUNNING')).toBe(false);
    expect(isTerminal('QUEUED')).toBe(false);
    expect(isTerminal(undefined)).toBe(false);
  });

  it('leaves timeouts and unreachable backends for resume, nothing else', () => {
    const t = new Error('x');
    t.name = 'PollTimeout';
    const u = new Error('y');
    u.name = 'PollUnreachable';
    expect(shouldLeaveForResume(t)).toBe(true);
    expect(shouldLeaveForResume(u)).toBe(true);
    expect(shouldLeaveForResume(new Error('validation'))).toBe(false);
    expect(shouldLeaveForResume('string')).toBe(false);
  });

  it('gives the generic agent at least the video and 3D budgets', () => {
    expect(POLL_BUDGET.generic.timeoutMs).toBeGreaterThanOrEqual(POLL_BUDGET.video.timeoutMs);
    expect(POLL_BUDGET.generic.timeoutMs).toBeGreaterThanOrEqual(POLL_BUDGET.model3d.timeoutMs);
  });
});
