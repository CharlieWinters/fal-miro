import { useEffect, useState } from 'react';
import { AGENT_UPDATE, type AgentUpdateMessage } from '../shared/messageTypes';
import { getActiveJobs, type ActiveJob } from '../shared/storage';

/**
 * Panel-side, in-memory job ledger. Tracks every `startAgentJob` call, listens
 * for AGENT_UPDATE postMessages from the headless iframe, and exposes the list
 * via a hook. Separate from `board.setAppData('fal:activeJobs', …)` (the
 * durable copy used for resume); this is the live in-panel view.
 */
export type LocalJob = {
  requestId: string;
  label: string;
  kind: 'image' | 'video' | 'audio' | 'model3d' | 'panorama' | 'rig' | 'generic';
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  message?: string;
  progress?: number;
  error?: string;
  startedAt: number;
  /** Fal queue request id, once the agent reports it — used to dedupe against
   *  the persisted (resume-on-reload) queue in the tray. */
  falRequestId?: string;
};

type Listener = (jobs: LocalJob[]) => void;

class JobLedger {
  private jobs: LocalJob[] = [];
  private listeners = new Set<Listener>();
  private wired = false;

  private wire() {
    if (this.wired) return;
    this.wired = true;
    window.addEventListener('message', (event: MessageEvent) => {
      const m = event.data as Partial<AgentUpdateMessage>;
      if (!m || m.type !== AGENT_UPDATE || !m.requestId) return;
      const job = this.jobs.find((j) => j.requestId === m.requestId);
      if (!job) return;

      job.status = m.status ?? job.status;
      if (typeof m.progress === 'number') job.progress = m.progress;
      if (m.message) job.message = m.message;
      if (m.falRequestId) job.falRequestId = m.falRequestId;
      if (m.status === 'failed') job.error = m.message ?? 'Failed';

      this.emit();

      if (m.status === 'succeeded' || m.status === 'failed') {
        const idToRemove = job.requestId;
        const lingerMs = m.status === 'failed' ? 10_000 : 4_000;
        setTimeout(() => this.remove(idToRemove), lingerMs);
      }
    });
  }

  add(job: LocalJob) {
    this.wire();
    this.jobs = [...this.jobs, job];
    this.emit();
  }

  remove(requestId: string) {
    this.jobs = this.jobs.filter((j) => j.requestId !== requestId);
    this.emit();
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.jobs);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private emit() {
    for (const l of this.listeners) l(this.jobs);
  }
}

export const jobLedger = new JobLedger();

export function useActiveJobs(): LocalJob[] {
  const [jobs, setJobs] = useState<LocalJob[]>([]);
  useEffect(() => jobLedger.subscribe(setJobs), []);
  return jobs;
}

/**
 * The durable active-jobs queue (board appData), polled so the panel shows
 * what's still in flight after a reload — including jobs started before the
 * panel was reopened. resume_jobs prunes finished ones, so they clear here too.
 */
export function usePersistedJobs(activeMs = 5000): ActiveJob[] {
  const [jobs, setJobs] = useState<ActiveJob[]>([]);
  useEffect(() => {
    let mounted = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Adaptive cadence: poll quickly only while jobs are in flight, slowly when
    // idle, and back off hard on error so a Miro rate-limit isn't kept pinned by
    // the poll itself. (Each getActiveJobs is a metered miro.board.getAppData.)
    const IDLE_MS = 30_000;
    const MAX_MS = 120_000;
    let delay = activeMs;

    const run = async () => {
      try {
        const j = await getActiveJobs();
        if (!mounted) return;
        setJobs(j);
        delay = j.length ? activeMs : IDLE_MS;
      } catch {
        if (!mounted) return;
        delay = Math.min(delay * 2, MAX_MS); // rate-limited / board not ready — back off
      }
      if (mounted) timer = setTimeout(run, delay);
    };

    void run();
    return () => {
      mounted = false;
      if (timer) clearTimeout(timer);
    };
  }, [activeMs]);
  return jobs;
}
