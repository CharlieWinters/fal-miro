import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_JOB_AGE_MS, MAX_JOB_FAILURES } from '../../../shared/jobRetry';
import type { ActiveJob } from '../../../shared/storage';

// A job that could never be answered used to sit in the ledger forever, retried
// on every board load. These tests are about the ledger, so everything that
// talks to the board or to Fal is a spy.
const h = vi.hoisted(() => ({
  getStatus: vi.fn(),
  replaceImageContent: vi.fn(),
  removeActiveJob: vi.fn(),
  ledger: [] as ActiveJob[],
}));

vi.mock('../../../lib/api', () => ({
  api: { getStatus: h.getStatus },
  videoEmbedUrl: vi.fn(),
  model3dEmbedUrl: vi.fn(),
  panoramaEmbedUrl: vi.fn(),
  rigEmbedUrl: vi.fn(),
  motionEmbedUrl: vi.fn(),
}));

vi.mock('../../../shared/boardHelpers', () => ({
  createEmbedAtPosition: vi.fn(),
  deleteItem: vi.fn(),
  makePlaceholderDataUrl: (ratio: string, text: string) => `data:placeholder/${ratio}/${text}`,
  parseRatio: () => ({ width: 100, height: 100 }),
  replaceImageContent: h.replaceImageContent,
  resolveAbsolutePosition: vi.fn(),
}));

vi.mock('../../../shared/pipelineRunner', () => ({ advancePipelineForJob: async () => false }));

vi.mock('../../../shared/storage', () => ({
  getActiveJobs: async () => h.ledger,
  removeActiveJob: h.removeActiveJob,
  setItemGenerationSettings: vi.fn(),
  // Emulate the real counter so the loop's own decision is what gets tested.
  recordJobFailure: async (requestId: string, error?: string) => {
    const job = h.ledger.find((j) => j.requestId === requestId);
    if (!job) return 0;
    job.failures = (job.failures ?? 0) + 1;
    job.lastError = error;
    return job.failures;
  },
  resetJobFailures: async (requestId: string) => {
    const job = h.ledger.find((j) => j.requestId === requestId);
    if (job) job.failures = 0;
  },
}));

const { run } = await import('./logic');

const job = (over: Partial<ActiveJob> = {}): ActiveJob => ({
  requestId: 'r1',
  endpointId: 'fal-ai/x',
  placeholderId: 'p1',
  kind: 'layers',
  createdAt: Date.now(),
  settings: { endpointId: 'fal-ai/x', input: {}, ratio: '3:4' },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.ledger = [];
});

describe('resume_jobs: a job that cannot be answered', () => {
  it('keeps resuming while the job still has failures in hand', async () => {
    h.ledger = [job()];
    h.getStatus.mockRejectedValue(new Error('Image exceeds 800 px per dimension'));

    for (let i = 1; i < MAX_JOB_FAILURES; i++) await run(null);

    expect(h.ledger[0].failures).toBe(MAX_JOB_FAILURES - 1);
    expect(h.removeActiveJob).not.toHaveBeenCalled();
  });

  it('abandons it once the failure budget is spent, instead of retrying forever', async () => {
    h.ledger = [job()];
    h.getStatus.mockRejectedValue(new Error('Image exceeds 800 px per dimension'));

    for (let i = 0; i < MAX_JOB_FAILURES; i++) await run(null);

    expect(h.removeActiveJob).toHaveBeenCalledWith('r1');
    // The board gets a resolution rather than a frozen "generating" tile.
    expect(h.replaceImageContent).toHaveBeenCalledWith(
      'p1',
      expect.stringContaining('Failed'),
      expect.stringContaining('Gave up'),
      undefined,
    );
  });

  it('drops a job past the age limit without spending a status call', async () => {
    h.ledger = [job({ createdAt: Date.now() - MAX_JOB_AGE_MS - 1 })];

    await run(null);

    expect(h.getStatus).not.toHaveBeenCalled();
    expect(h.removeActiveJob).toHaveBeenCalledWith('r1');
  });

  it('still drops the ledger entry when the placeholder cannot be updated', async () => {
    // The placeholder is often the thing that is gone. If that threw, we would
    // be straight back to a job that retries on every load.
    h.ledger = [job({ failures: MAX_JOB_FAILURES })];
    h.replaceImageContent.mockRejectedValue(new Error('item not found'));

    await run(null);

    expect(h.removeActiveJob).toHaveBeenCalledWith('r1');
  });

  it('forgets earlier failures once a check succeeds', async () => {
    h.ledger = [job({ failures: MAX_JOB_FAILURES - 1 })];
    h.getStatus.mockResolvedValue({ status: 'RUNNING', requestId: 'r1', endpointId: 'fal-ai/x' });

    await run(null);

    expect(h.ledger[0].failures).toBe(0);
    expect(h.removeActiveJob).not.toHaveBeenCalled();
  });

  it('leaves a healthy job alone', async () => {
    h.ledger = [job()];
    h.getStatus.mockResolvedValue({ status: 'QUEUED', requestId: 'r1', endpointId: 'fal-ai/x' });

    const res = await run(null);

    expect(res).toEqual({ resumed: 1, finalized: 0 });
    expect(h.removeActiveJob).not.toHaveBeenCalled();
    expect(h.replaceImageContent).not.toHaveBeenCalled();
  });
});
