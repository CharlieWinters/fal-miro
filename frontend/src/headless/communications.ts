import { agentRegistry } from '../shared/agentRegistry';
import {
  RUN_AGENT,
  AGENT_UPDATE,
  type RunAgentMessage,
  type AgentUpdateMessage,
} from '../shared/messageTypes';

const currentOrigin = window.location.origin;
let listenerAttached = false;

/** Broadcast a progress update back to whichever frames are listening. */
export function broadcastUpdate(update: Omit<AgentUpdateMessage, 'type'>): void {
  const message: AgentUpdateMessage = { type: AGENT_UPDATE, ...update };
  try {
    for (let i = 0; i < window.parent.frames.length; i++) {
      try {
        window.parent.frames[i].postMessage(message, '*');
      } catch {
        /* cross-origin frame, ignore */
      }
    }
    window.parent.postMessage(message, '*');
  } catch (err) {
    console.warn('[headless] broadcastUpdate failed:', err);
  }
}

const handleMessage = async (event: MessageEvent) => {
  if (event.origin !== currentOrigin) return;

  const message = event.data as Partial<RunAgentMessage>;
  if (!message || typeof message !== 'object') return;
  if (message.type !== RUN_AGENT) return;

  const { agentId, payload, requestId = '' } = message;
  if (!agentId) return;

  const agent = agentRegistry[agentId];
  if (!agent?.run) {
    console.warn(`[headless] Unknown agent: ${agentId}`);
    broadcastUpdate({
      requestId,
      status: 'failed',
      message: `Unknown agent: ${agentId}`,
    });
    return;
  }

  try {
    console.log(`[headless] Running agent "${agentId}"`, payload);
    const data = await agent.run(payload, requestId);
    broadcastUpdate({ requestId, status: 'succeeded', data });
  } catch (err) {
    console.error(`[headless] Agent "${agentId}" failed:`, err);
    broadcastUpdate({
      requestId,
      status: 'failed',
      message: err instanceof Error ? err.message : String(err),
    });
  }
};

export function initializeMessageListener(): void {
  if (listenerAttached) return;
  window.addEventListener('message', handleMessage);
  listenerAttached = true;
  console.log('[headless] RUN_AGENT listener ready');
}

initializeMessageListener();
