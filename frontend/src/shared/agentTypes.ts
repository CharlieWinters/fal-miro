// The agent contract.
//
// Split from the registry that aggregates agents (headless/agentRegistry.ts)
// so that the message listener can be typed against an agent without importing
// every agent — the same split pipelineAppTypes.ts makes for apps, and for the
// same reason. Contracts are shared; composition is not.

export interface AgentMeta {
  id: string;
  name: string;
  run: (payload: unknown, requestId?: string) => Promise<unknown>;
}

/** id → agent. Built at the composition root, injected into the listener. */
export type AgentRegistry = Record<string, AgentMeta>;
