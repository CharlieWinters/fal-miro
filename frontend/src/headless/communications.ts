import type { AgentRegistry } from '../shared/agentTypes';
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

const makeHandler = (registry: AgentRegistry) => async (event: MessageEvent) => {
  if (event.origin !== currentOrigin) return;

  const message = event.data as Partial<RunAgentMessage>;
  if (!message || typeof message !== 'object') return;
  if (message.type !== RUN_AGENT) return;

  const { agentId, payload, requestId = '' } = message;
  if (!agentId) return;

  const agent = registry[agentId];
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
    console.error(`[headless] Agent "${agentId}" failed:`, err, describeApiErrorBody(err));
    broadcastUpdate({
      requestId,
      status: 'failed',
      message: describeApiErrorBody(err) ?? (err instanceof Error ? err.message : String(err)),
    });
  }
};

/**
 * `err.message` on a client-mode (@fal-ai/client) validation error is just
 * "Unprocessable Entity" — the actual per-field reason lives in `err.body`
 * (FastAPI-style `{ detail: [{ loc, msg, type }] }`, or occasionally a plain
 * string). Duck-typed rather than importing the SDK's error classes, since
 * this handler is agent-agnostic and a backend-mode failure won't have this
 * shape at all.
 */
function describeApiErrorBody(err: unknown): string | null {
  const body = (err as { body?: unknown } | null)?.body;
  if (!body || typeof body !== 'object') return null;
  const detail = (body as { detail?: unknown }).detail;
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) {
    const parts = detail.map((d) =>
      d && typeof d === 'object' ? `${(d as { loc?: unknown[] }).loc?.join('.') ?? ''}: ${(d as { msg?: unknown }).msg ?? ''}` : String(d),
    );
    if (parts.length) return parts.join('; ');
  }
  return null;
}

/**
 * Start listening for RUN_AGENT.
 *
 * The registry is passed in rather than imported so that this module stays
 * below the agents in the dependency graph. Importing it here would close the
 * loop — agent logic imports broadcastUpdate from this file, so this file
 * importing the registry (which imports every agent) would make the two
 * mutually dependent. headless/index.ts is the composition root and is the
 * only place that knows both halves.
 */
export function initializeMessageListener(registry: AgentRegistry): void {
  if (listenerAttached) return;
  window.addEventListener('message', makeHandler(registry));
  listenerAttached = true;
  console.log('[headless] RUN_AGENT listener ready');
}
