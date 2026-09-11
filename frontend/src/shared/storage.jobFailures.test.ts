import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActiveJob } from './storage';

// The ledger lives in board appData, so the fake board is the whole fixture.
// Note the 1.5 s read cache inside storage.ts: every write busts it, which is
// why these sequential read/write pairs see fresh data.
const appData: Record<string, unknown> = {};
const setAppData = vi.fn(async (key: string, value: unknown) => {
  appData[key] = value;
});

beforeEach(() => {
  for (const k of Object.keys(appData)) delete appData[k];
  vi.clearAllMocks();
  // storage.ts holds its read cache at module scope, so a fresh module per test
  // is what keeps one test's ledger out of the next one's reads.
  vi.resetModules();
  (globalThis as { miro?: unknown }).miro = {
    board: {
      getAppData: async () => ({ ...appData }),
      setAppData,
    },
  };
});

const job = (requestId: string, over: Partial<ActiveJob> = {}): ActiveJob => ({
  requestId,
  endpointId: 'fal-ai/x',
  placeholderId: 'p1',
  kind: 'layers',
  createdAt: 1_800_000_000_000,
  settings: { endpointId: 'fal-ai/x', input: {}, ratio: '1:1' },
  ...over,
});

async function load() {
  const { getActiveJobs } = await import('./storage');
  return getActiveJobs();
}

describe('recordJobFailure', () => {
  it('counts consecutive failures and keeps the reason', async () => {
    const { addActiveJob, recordJobFailure } = await import('./storage');
    await addActiveJob(job('r1'));

    expect(await recordJobFailure('r1', 'Image exceeds 800 px per dimension')).toBe(1);
    expect(await recordJobFailure('r1', 'Image exceeds 800 px per dimension')).toBe(2);

    const [stored] = await load();
    expect(stored.failures).toBe(2);
    expect(stored.lastError).toMatch(/800 px/);
  });

  it('leaves other jobs alone', async () => {
    const { addActiveJob, recordJobFailure } = await import('./storage');
    await addActiveJob(job('r1'));
    await addActiveJob(job('r2'));

    await recordJobFailure('r1', 'boom');

    const jobs = await load();
    expect(jobs.find((j) => j.requestId === 'r1')?.failures).toBe(1);
    expect(jobs.find((j) => j.requestId === 'r2')?.failures).toBeUndefined();
  });

  it('reports 0 and writes nothing for a job that has already been removed', async () => {
    const { recordJobFailure } = await import('./storage');
    expect(await recordJobFailure('ghost', 'boom')).toBe(0);
    expect(setAppData).not.toHaveBeenCalled();
  });

  it('truncates a long error rather than spending the appData budget on it', async () => {
    const { addActiveJob, recordJobFailure } = await import('./storage');
    await addActiveJob(job('r1'));
    await recordJobFailure('r1', 'x'.repeat(5000));
    const [stored] = await load();
    expect((stored.lastError ?? '').length).toBeLessThanOrEqual(200);
  });
});

describe('resetJobFailures', () => {
  it('clears the count after a check succeeds', async () => {
    const { addActiveJob, recordJobFailure, resetJobFailures } = await import('./storage');
    await addActiveJob(job('r1'));
    await recordJobFailure('r1', 'boom');

    await resetJobFailures('r1');

    const [stored] = await load();
    expect(stored.failures).toBe(0);
    expect(stored.lastError).toBeUndefined();
  });

  it('writes nothing when there is no count to clear', async () => {
    const { addActiveJob, resetJobFailures } = await import('./storage');
    await addActiveJob(job('r1'));
    setAppData.mockClear();

    await resetJobFailures('r1');
    await resetJobFailures('ghost');

    expect(setAppData).not.toHaveBeenCalled();
  });
});
