import {
  RUN_AGENT,
  AGENT_UPDATE,
  type RunAgentMessage,
  type AgentUpdateMessage,
} from '../shared/messageTypes';
import { jobLedger, type LocalJob } from './jobs';
import { isOurs, postToSiblings } from '../shared/frameMessaging';

let nextId = 1;
const newRequestId = () => `req_${Date.now()}_${nextId++}`;

// Same-origin only (see shared/frameMessaging): every other installed Miro
// app is a sibling iframe on this page, and a RUN_AGENT carries the prompt.
function postRunAgent(message: RunAgentMessage): void {
  postToSiblings(message);
}

/**
 * Send a RUN_AGENT message and resolve when an AGENT_UPDATE with
 * status succeeded|failed comes back. `onProgress` fires on intermediate updates.
 */
export function runAgent<T = unknown>(
  agentId: string,
  payload: unknown,
  onProgress?: (u: AgentUpdateMessage) => void,
): Promise<T> {
  const requestId = newRequestId();
  postRunAgent({ type: RUN_AGENT, agentId, requestId, payload, source: 'panel' });

  return new Promise<T>((resolve, reject) => {
    const onMessage = (event: MessageEvent) => {
      if (!isOurs(event)) return;
      const m = event.data as Partial<AgentUpdateMessage>;
      if (!m || m.type !== AGENT_UPDATE || m.requestId !== requestId) return;

      if (m.status === 'queued' || m.status === 'running') {
        if (onProgress) onProgress(m as AgentUpdateMessage);
        return;
      }
      window.removeEventListener('message', onMessage);
      if (m.status === 'succeeded') resolve(m.data as T);
      else reject(new Error(m.message ?? 'Agent failed'));
    };
    window.addEventListener('message', onMessage);
  });
}

/**
 * Fire-and-forget. Registers a job in the shared ledger (so the ActiveJobsTray
 * shows it) and returns the requestId. The user can keep working / start more.
 */
export function startAgentJob(opts: {
  agentId: string;
  label: string;
  kind: LocalJob['kind'];
  payload: unknown;
}): string {
  const requestId = newRequestId();

  jobLedger.add({
    requestId,
    label: opts.label,
    kind: opts.kind,
    status: 'queued',
    startedAt: Date.now(),
  });

  postRunAgent({ type: RUN_AGENT, agentId: opts.agentId, requestId, payload: opts.payload, source: 'panel' });
  return requestId;
}
