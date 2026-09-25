// The headless half of the embed-node channel. node.html (an embed on the
// board, no SDK) asks; this iframe (has the SDK, runs for anyone with the app
// installed, panel open or not) answers from board state.
//
// Two requests, and neither spends money — see node.ts, rule 1:
//   hello {nid} → the node's state (model, settings, wired references, prompt,
//                  last result), read from the embed's metadata and connectors
//   open  {nid} → open the panel on this node, where Generate lives

import { findModel } from '../shared/falCatalog';
import { getConnectedResources } from '../shared/boardHelpers';
import { isOurs, ownOrigin, postToSiblings } from '../shared/frameMessaging';
import { NODE_MSG, buildNodeState, parseNodeRequest, type NodeState } from '../shared/node';
import { findNodeByNid } from '../shared/nodeBoard';

function reply(event: MessageEvent, payload: Record<string, unknown>): void {
  // Exact origin — the one we already checked the request came from.
  (event.source as Window | null)?.postMessage(payload, ownOrigin());
}

async function stateFor(nid: string): Promise<NodeState> {
  const node = await findNodeByNid(nid);
  if (!node) return { nid, found: false };
  const connected = await getConnectedResources(node.embed.id);
  return buildNodeState(node.meta, connected, findModel(node.meta.recipe.endpointId)?.label);
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

async function handle(event: MessageEvent): Promise<void> {
  if (!isOurs(event)) return;
  const req = parseNodeRequest(event.data);
  if (!req) return;

  if (req.type === NODE_MSG.hello) {
    reply(event, { type: NODE_MSG.state, v: 1, ...(await stateFor(req.nid)) });
    return;
  }
  try {
    await openOnNode(req.nid);
    reply(event, { type: NODE_MSG.opened, v: 1, nid: req.nid });
  } catch (e) {
    reply(event, { type: NODE_MSG.error, v: 1, nid: req.nid, error: e instanceof Error ? e.message : String(e) });
  }
}

export function initNodeBridge(): void {
  window.addEventListener('message', (event) => {
    handle(event).catch((err) => console.error('[nodeBridge] handler error:', err));
  });
}
