// Embed nodes — the pure half: what a node stores, what crosses the channel,
// and how a state report is assembled. Nothing here touches the SDK or the
// DOM, so all of it is unit-tested; the board half is nodeBoard.ts and the
// transport is headless/nodeBridge.ts.
//
// A node is an embed widget pointing at node.html, made by the app (never by
// the Miro MCP — an MCP-authored embed stores an empty url, verified 25 Sep
// 2026). It replaces the settings card: the card's recipe moves into the
// embed's own app metadata, and the node page asks the headless iframe for
// its state over postMessage, so it works with the panel closed.
//
// The security rules come from miro-terminal's host bridge:
//   1. A node can ask for its state, ask to open the panel on itself, or ask
//      to generate. None of those runs a model or spends money: generate only
//      opens the app's own confirm modal, and the run starts when the
//      director clicks Generate there, with the cost shown. The modal builds
//      the run from the board, never from the message.
//   2. A node sends only its nid. Everything the app does is read from the
//      board (the embed's metadata, its connectors), never from the message.
//   3. Exact origins only, never '*'.
//   4. No keys, tokens or backend URLs cross the channel.
//
// `charliewinters.github.io` is shared by every Pages repo on that account,
// so any of them passes an origin check. Rule 1 is what makes that harmless.

import type { RecipeCard } from './recipeCard';
import type { ResolvedBoardItems } from './boardHelpers';

/** App-metadata key on the node embed. Scoped to this app by Miro. */
export const NODE_METADATA_KEY = 'fal-node';
export const NODE_VERSION = 1;

/**
 * Node size on the board. Tall rather than wide, because the node will grow
 * the model's own form (Generate from the node, a later step) and that form is
 * laid out for the panel's column (~368 px).
 */
export const NODE_SIZE = { width: 400, height: 560 } as const;

export type NodeOutput = {
  url: string;
  kind: 'image' | 'video';
  /** An http(s) still for a video output — also what the node's poster becomes. */
  posterUrl?: string;
  /** ISO timestamp. */
  at: string;
  by?: string | null;
};

export type NodeMeta = {
  v: typeof NODE_VERSION;
  /** Random id carried in the embed URL; how node.html names itself. */
  nid: string;
  /** Shown on the node, e.g. "Shot 2". */
  title: string;
  /** The settings card's recipe, unchanged. */
  recipe: RecipeCard;
  lastOutput?: NodeOutput | null;
};

export const NODE_MSG = {
  hello: 'fal-node:hello',
  state: 'fal-node:state',
  open: 'fal-node:open',
  /** Node → headless: open the confirm modal for a run. */
  generate: 'fal-node:generate',
  opened: 'fal-node:opened',
  error: 'fal-node:error',
  /** Headless → nodes: a node's metadata changed; re-ask. */
  changed: 'fal-node:changed',
  /** Headless → panel: open this node (for a panel that is already open). */
  focus: 'fal-node:focus',
} as const;

type RequestType = typeof NODE_MSG.hello | typeof NODE_MSG.open | typeof NODE_MSG.generate;
const REQUEST_TYPES: readonly string[] = [NODE_MSG.hello, NODE_MSG.open, NODE_MSG.generate];

/** What node.html sends. Only these three, and only a nid. */
export type NodeRequest = { type: RequestType; v: 1; nid: string };

export function parseNodeRequest(data: unknown): NodeRequest | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (typeof d.type !== 'string' || !REQUEST_TYPES.includes(d.type)) return null;
  if (typeof d.nid !== 'string' || !isNid(d.nid)) return null;
  return { type: d.type as RequestType, v: 1, nid: d.nid };
}

/** A nid is a UUID. Checked so a message can't smuggle anything else through. */
export function isNid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

/** Validate metadata read back from the board. Anything off-shape is "not a node". */
export function parseNodeMeta(raw: unknown): NodeMeta | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  if (m.v !== NODE_VERSION || typeof m.nid !== 'string' || !isNid(m.nid)) return null;
  const r = m.recipe as Record<string, unknown> | undefined;
  if (!r || typeof r.endpointId !== 'string' || typeof r.capability !== 'string') return null;
  if (!r.input || typeof r.input !== 'object') return null;
  return {
    v: NODE_VERSION,
    nid: m.nid,
    title: typeof m.title === 'string' ? m.title : '',
    recipe: r as unknown as RecipeCard,
    lastOutput: parseOutput(m.lastOutput),
  };
}

function parseOutput(raw: unknown): NodeOutput | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.url !== 'string' || !/^https?:\/\//.test(o.url)) return null;
  if (o.kind !== 'image' && o.kind !== 'video') return null;
  return {
    url: o.url,
    kind: o.kind,
    ...(typeof o.posterUrl === 'string' && /^https?:\/\//.test(o.posterUrl) ? { posterUrl: o.posterUrl } : {}),
    at: typeof o.at === 'string' ? o.at : '',
    by: typeof o.by === 'string' ? o.by : null,
  };
}

/**
 * A settings card's title is "Shot 2 · MiniMax H3 Reference to Video" or
 * "Settings · <model>". The node shows the part before the model.
 */
export function nodeTitleFromCard(cardTitle: string | undefined): string {
  const plain = (cardTitle ?? '').replace(/<[^>]+>/g, '').trim();
  const head = plain.split('·')[0]?.trim() ?? '';
  return head && head.toLowerCase() !== 'settings' ? head : 'Fal node';
}

/** What the node page renders. Built in headless from board state only. */
export type NodeState = {
  nid: string;
  found: boolean;
  title?: string;
  modelLabel?: string;
  endpointId?: string;
  settings?: Array<{ label: string; value: string }>;
  prompt?: { text: string; source: 'sticky' | 'saved' } | null;
  references?: { images: string[]; videos: string[]; audios: string[] };
  lastOutput?: NodeOutput | null;
  /** Generate from the node is offered for reference-to-video models only, for now. */
  canGenerate?: boolean;
  costUSD?: number;
  /** A run anchored on this node, as the headless iframe last heard of it. */
  job?: NodeJob | null;
};

export type NodeJob = { status: 'running' | 'succeeded' | 'failed'; message?: string; startedAt: number };

/** Input keys worth showing on the node, in display order. */
const SHOWN_SETTINGS: Array<[key: string, label: string]> = [
  ['aspect_ratio', 'Aspect'],
  ['resolution', 'Resolution'],
  ['duration', 'Duration'],
  ['num_images', 'Images'],
];

const PROMPT_EXCERPT = 280;

export function buildNodeState(
  meta: NodeMeta,
  connected: ResolvedBoardItems,
  modelLabel: string | undefined,
): NodeState {
  const input = meta.recipe.input ?? {};
  const settings: Array<{ label: string; value: string }> = [];
  for (const [key, label] of SHOWN_SETTINGS) {
    const v = input[key];
    if (v === undefined || v === null || v === '') continue;
    settings.push({ label, value: key === 'duration' && /^\d+$/.test(String(v)) ? `${v} s` : String(v) });
  }

  // Same precedence the model screens use: a wired sticky is the prompt; the
  // saved one is the fallback when nothing is wired.
  const stickyText = connected.stickies
    .map((s) => stripTags(s.content))
    .filter(Boolean)
    .join('\n');
  const saved = typeof input.prompt === 'string' ? input.prompt : '';
  const prompt = stickyText
    ? { text: excerpt(stickyText), source: 'sticky' as const }
    : saved
      ? { text: excerpt(saved), source: 'saved' as const }
      : null;

  const name = (i: { id: string; title?: string }) => i.title?.trim() || 'untitled';
  return {
    nid: meta.nid,
    found: true,
    title: meta.title,
    modelLabel: modelLabel || meta.recipe.endpointId,
    endpointId: meta.recipe.endpointId,
    settings,
    prompt,
    references: {
      images: connected.images.map(name),
      videos: connected.videos.map(name),
      audios: connected.audios.map(name),
    },
    lastOutput: meta.lastOutput ?? null,
  };
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function excerpt(s: string): string {
  return s.length > PROMPT_EXCERPT ? `${s.slice(0, PROMPT_EXCERPT - 1).trimEnd()}…` : s;
}
