// Cross-frame postMessage contract (panel/modal → headless and back).

export const RUN_AGENT = 'RUN_AGENT';
export const AGENT_UPDATE = 'AGENT_UPDATE';

export type RunAgentMessage = {
  type: typeof RUN_AGENT;
  agentId: string;
  requestId: string;
  payload: unknown;
  source: 'panel' | 'modal';
};

export type AgentUpdateMessage = {
  type: typeof AGENT_UPDATE;
  requestId: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  progress?: number; // 0..1
  message?: string;
  data?: unknown;
  /** Fal queue request id, once known — lets the panel correlate a live job
   *  with its persisted (resume-on-reload) entry so the tray doesn't dup it. */
  falRequestId?: string;
};
