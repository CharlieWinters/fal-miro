// The headless half of the embed-node channel. node.html (an embed on the
// board, no SDK) asks; this iframe (has the SDK, runs for anyone with the app
// installed, panel open or not) answers from board state.
//
// Three requests. Only generate spends money, and it can't choose what runs
// — see node.ts, rule 1:
//   hello    {nid} → the node's state, read from its metadata and connectors
//   open     {nid} → open the panel on this node
//   generate {nid} → build this node's run from the board and start it, by
//                    posting RUN_AGENT exactly as the panel does
//
// It also watches runs anchored on a node (RUN_AGENT / AGENT_UPDATE pass
// through this frame) so the node can show progress.

import { findModel, isReferenceToVideo, type FalModel } from '../shared/falCatalog';
import { getConnectedResources } from '../shared/boardHelpers';
import { estimateCostUSD } from '../shared/cost';
import { isOurs, ownOrigin, postToAllFrames, postToSiblings } from '../shared/frameMessaging';
import { AGENT_UPDATE, RUN_AGENT } from '../shared/messageTypes';
import { NODE_MSG, buildNodeState, parseNodeRequest, type NodeJob, type NodeState } from '../shared/node';
import { findNodeByNid, readNode } from '../shared/nodeBoard';
import { buildNodeRun } from '../shared/nodeRun';

function reply(event: MessageEvent, payload: Record<string, unknown>): void {
  // Exact origin — the one we already checked the request came from.
  (event.source as Window | null)?.postMessage(payload, ownOrigin());
}

/** embed id → the latest run anchored on it. In memory: a reload forgets it,
 *  and the node falls back to its last recorded result. */
const jobs = new Map<string, NodeJob>();
/** requestId → embed id, for matching updates back to their node. */
const requestToNode = new Map<string, string>();

function modelFor(endpointId: string, capability: string): FalModel {
  return findModel(endpointId) ?? ({ endpointId, label: endpointId, capability } as FalModel);
}

async function stateFor(nid: string): Promise<NodeState> {
  const node = await findNodeByNid(nid);
  if (!node) return { nid, found: false };
  const { recipe } = node.meta;
  const model = modelFor(recipe.endpointId, recipe.capability);
  const [connected, costUSD] = await Promise.all([
    getConnectedResources(node.embed.id),
    estimateCostUSD(recipe.endpointId, { units: 1, seconds: Number(recipe.input?.duration) || undefined }),
  ]);
  return {
    ...buildNodeState(node.meta, connected, findModel(recipe.endpointId)?.label),
    canGenerate: isReferenceToVideo(model),
    ...(costUSD !== undefined ? { costUSD } : {}),
    job: jobs.get(node.embed.id) ?? null,
  };
}

async function openOnNode(nid: string): Promise<void> {
  const node = await findNodeByNid(nid);
  if (!node) throw new Error('This node is no longer on the board.');
  // A panel that is already open hears this and switches; a closed one is
  // opened on the node. Both, because there is no way to ask which it is.
  postToSiblings({ type: NODE_MSG.focus, v: 1, embedId: node.embed.id });
  try {
    await miro.board.ui.openPanel({ url: `app.html?node=${encodeURIComponent(node.embed.id)}` });
  } catch (e) {
    // Miro refuses when a panel is already showing; the focus message above
    // has already reached it.
    console.info('[nodeBridge] openPanel declined, relying on focus message', e);
  }
}

/** Nodes whose run is being assembled, so a double click can't start two. */
const starting = new Set<string>();

/**
 * Start a node's run. Everything in it — model, prompt, references, settings
 * — is read from the board by buildNodeRun; the message only named the node.
 * Posted as RUN_AGENT to our own frames, so the same listener that runs the
 * panel's jobs runs this one, and watchJobs below picks it up for progress.
 */
async function generateFromNode(nid: string): Promise<void> {
  const node = await findNodeByNid(nid);
  if (!node) throw new Error('This node is no longer on the board.');
  const id = node.embed.id;
  if (starting.has(id) || jobs.get(id)?.status === 'running') throw new Error('This node is already generating.');
  starting.add(id);
  try {
    const plan = await buildNodeRun(id);
    const requestId = `node_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    jobs.set(id, { status: 'running', message: 'Starting…', startedAt: Date.now() });
    postToSiblings({ type: RUN_AGENT, agentId: 'fal_video_gen', requestId, payload: plan.payload, source: 'node' });
  } finally {
    starting.delete(id);
  }
}

async function handle(event: MessageEvent): Promise<void> {
  if (!isOurs(event)) return;
  const req = parseNodeRequest(event.data);
  if (!req) return;

  if (req.type === NODE_MSG.hello) {
    reply(event, { type: NODE_MSG.state, v: 1, ...(await stateFor(req.nid)) });
    return;
  }
  try {
    if (req.type === NODE_MSG.generate) await generateFromNode(req.nid);
    else await openOnNode(req.nid);
    reply(event, { type: NODE_MSG.opened, v: 1, nid: req.nid, what: req.type === NODE_MSG.generate ? 'started' : 'panel' });
  } catch (e) {
    reply(event, { type: NODE_MSG.error, v: 1, nid: req.nid, error: e instanceof Error ? e.message : String(e) });
  }
}

/** Nudge the node, at most every couple of seconds while a run reports progress. */
const lastNudge = new Map<string, number>();
async function nudge(embedId: string, force = false): Promise<void> {
  const now = Date.now();
  if (!force && now - (lastNudge.get(embedId) ?? 0) < 2000) return;
  lastNudge.set(embedId, now);
  const node = await readNode(embedId);
  if (node) postToAllFrames({ type: NODE_MSG.changed, v: 1, nid: node.meta.nid });
}

/**
 * Runs pass through this frame whichever surface started them (a node's
 * Generate, or the panel opened on a node). Only same-origin messages count, and
 * nothing here acts on them beyond remembering status for display.
 */
function watchJobs(event: MessageEvent): void {
  if (!isOurs(event)) return;
  const d = event.data as {
    type?: string;
    requestId?: string;
    status?: string;
    message?: string;
    payload?: { cardAnchorId?: unknown };
  } | null;
  if (!d || typeof d !== 'object' || typeof d.requestId !== 'string') return;

  if (d.type === RUN_AGENT) {
    const anchor = d.payload?.cardAnchorId;
    if (typeof anchor !== 'string') return;
    void readNode(anchor).then((node) => {
      if (!node) return;
      requestToNode.set(d.requestId as string, anchor);
      jobs.set(anchor, { status: 'running', message: 'Starting…', startedAt: Date.now() });
      void nudge(anchor, true);
    });
    return;
  }
  if (d.type === AGENT_UPDATE) {
    const embedId = requestToNode.get(d.requestId);
    if (!embedId) return;
    const prev = jobs.get(embedId);
    const status = d.status === 'succeeded' ? 'succeeded' : d.status === 'failed' ? 'failed' : 'running';
    jobs.set(embedId, { status, message: d.message, startedAt: prev?.startedAt ?? Date.now() });
    if (status !== 'running') requestToNode.delete(d.requestId);
    void nudge(embedId, status !== 'running');
  }
}

export function initNodeBridge(): void {
  window.addEventListener('message', (event) => {
    watchJobs(event);
    handle(event).catch((err) => console.error('[nodeBridge] handler error:', err));
  });
}
