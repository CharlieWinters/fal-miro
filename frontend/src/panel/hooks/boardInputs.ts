// Shared "board inputs" layer — the one place screens reach for board content to
// put into a request. Three primitives, mapping onto whatever a model's schema
// exposes:
//   • single image  → useFirstSelected('image')      ("use the selected image")
//   • image/video array → useBoardReferences()        (bulk, frame-aware)
//   • prompt/text    → useSelectedStickyText()         (stickies → prompt)
//
// Consolidated here so any model screen — hand-built or the future generic form
// — gets the same easy selection behaviour instead of reinventing it.

import { useEffect, useMemo, useState } from 'react';
import { unwrapVideoEmbedUrl, unwrapAudioEmbedUrl } from '../../lib/api';
import { cachedBoardGet, getDocumentText, stripHtml } from '../../shared/boardHelpers';

export { useFirstSelected, useSelectedItems } from './useSelection';

/** A board item chosen as an input (id + optional board title). */
export type BoardRef = { id: string; title?: string };

const clean = (t?: string) => (t ?? '').trim() || undefined;

/**
 * Collect input references from the current selection: selected images,
 * video embeds, and audio embeds, plus everything inside any selected frame —
 * so you can drop refs into a "References" frame, select it, and grab them
 * all in one click. Ordering follows board read order.
 */
export async function collectBoardReferences(): Promise<{
  images: BoardRef[];
  videos: BoardRef[];
  audios: BoardRef[];
  /** The single frame the references were collected from, if the selection
   *  was (or resolved through) exactly one frame — lets a generation place
   *  its output below that same frame instead of a specific reference item. */
  frameId?: string;
}> {
  const sel = (await miro.board.getSelection()) as Array<{
    id: string;
    type: string;
    url?: string;
    title?: string;
    parentId?: string;
  }>;
  const images = new Map<string, BoardRef>();
  const videos = new Map<string, BoardRef>();
  const audios = new Map<string, BoardRef>();
  const frameIds: string[] = [];

  const add = (it: { id: string; type: string; url?: string; title?: string }) => {
    if (it.type === 'image') images.set(it.id, { id: it.id, title: clean(it.title) });
    else if (it.type === 'embed' && it.url && unwrapVideoEmbedUrl(it.url))
      videos.set(it.id, { id: it.id, title: clean(it.title) });
    else if (it.type === 'embed' && it.url && unwrapAudioEmbedUrl(it.url))
      audios.set(it.id, { id: it.id, title: clean(it.title) });
    else if (it.type === 'frame') frameIds.push(it.id);
  };
  sel.forEach(add);

  if (frameIds.length) {
    const [imgs, embeds] = await Promise.all([cachedBoardGet('image'), cachedBoardGet('embed')]);
    for (const it of imgs as Array<BoardRef & { parentId?: string }>) {
      if (it.parentId && frameIds.includes(it.parentId)) images.set(it.id, { id: it.id, title: clean(it.title) });
    }
    for (const it of embeds as Array<BoardRef & { parentId?: string; url?: string }>) {
      if (!it.parentId || !frameIds.includes(it.parentId) || !it.url) continue;
      if (unwrapVideoEmbedUrl(it.url)) videos.set(it.id, { id: it.id, title: clean(it.title) });
      else if (unwrapAudioEmbedUrl(it.url)) audios.set(it.id, { id: it.id, title: clean(it.title) });
    }
  }

  return {
    images: [...images.values()],
    videos: [...videos.values()],
    audios: [...audios.values()],
    frameId: frameIds.length === 1 ? frameIds[0] : undefined,
  };
}

type BoardRefs = { images: BoardRef[]; videos: BoardRef[]; audios: BoardRef[]; frameId?: string };

/** Live board references (images + video/audio embeds), refreshed on selection change. */
export function useBoardReferences(): BoardRefs {
  const [refs, setRefs] = useState<BoardRefs>({ images: [], videos: [], audios: [] });

  useEffect(() => {
    let mounted = true;
    const apply = () => {
      collectBoardReferences()
        .then((r) => mounted && setRefs(r))
        .catch((e) => console.warn('[boardInputs] collect failed', e));
    };
    apply();
    const handler = () => apply();
    miro.board.ui.on('selection:update', handler);
    return () => {
      mounted = false;
      try {
        miro.board.ui.off('selection:update', handler);
      } catch {
        /* older SDKs */
      }
    };
  }, []);

  return refs;
}

/** Join sticky text left-to-right by board x (first sticky → start of prompt). */
export function orderedStickyText(items: Array<{ content?: string; x?: number }>): string {
  return items
    .slice()
    .sort((a, b) => (a.x ?? 0) - (b.x ?? 0))
    .map((s) => stripHtml(s.content ?? ''))
    .filter(Boolean)
    .join('\n');
}

export type SelectedSticky = { id: string; content?: string; x?: number };

/**
 * Selected sticky notes, plus any sticky note inside a selected frame — same
 * frame-expansion rule as `collectBoardReferences`, so a prompt sticky left
 * inside a "prompt frame" is picked up the moment the frame (or its card) is
 * selected, not just when the sticky itself is.
 *
 * Doc-format items in the same selection/frame are folded into the same list
 * — a Doc plays the same "supplies prompt text" role as a sticky, just with
 * its text fetched from the backend (see `getDocumentText`) instead of read
 * straight off the Web SDK item. The SDK has no accessor for Docs at all
 * (confirmed live: it reports one as a bare geometry shell tagged
 * `type: 'unsupported'`, indistinguishable from any other item type the SDK
 * doesn't have a class for) — so every `unsupported` item is a *candidate*
 * here, and `getDocumentText`'s REST call (which sees the real `doc_format`
 * type) decides for real; a non-Doc `unsupported` item just contributes
 * nothing. Silently contributes nothing either way if the current Miro
 * account isn't connected (Settings → "Connect Miro account") — a doc nobody
 * can read yet behaves like an empty sticky, not an error.
 */
export async function collectSelectedStickies(): Promise<SelectedSticky[]> {
  const sel = (await miro.board.getSelection()) as Array<SelectedSticky & { type: string }>;
  const stickies = new Map<string, SelectedSticky>();
  const frameIds: string[] = [];
  const docCandidates = new Map<string, SelectedSticky>();

  for (const it of sel) {
    if (it.type === 'sticky_note') stickies.set(it.id, it);
    else if (it.type === 'unsupported') docCandidates.set(it.id, it);
    else if (it.type === 'frame') frameIds.push(it.id);
  }

  if (frameIds.length) {
    // Sticky notes are a real, filterable type — query by type directly. Doc
    // candidates are the SDK's generic 'unsupported' label, not a genuine
    // widget type, so filtering server-side by it is unverified/risky (see
    // cachedBoardGet) — fetch every item instead and filter client-side,
    // same as the direct-selection path above already does via
    // getSelection()'s unfiltered result.
    const [stickyItems, allItems] = await Promise.all([
      cachedBoardGet('sticky_note') as Promise<Array<SelectedSticky & { parentId?: string }>>,
      cachedBoardGet() as Promise<Array<SelectedSticky & { type: string; parentId?: string }>>,
    ]);
    for (const it of stickyItems) {
      if (it.parentId && frameIds.includes(it.parentId)) stickies.set(it.id, it);
    }
    for (const it of allItems) {
      if (it.type === 'unsupported' && it.parentId && frameIds.includes(it.parentId)) docCandidates.set(it.id, it);
    }
  }

  if (docCandidates.size) {
    let userId: string | undefined;
    try {
      userId = (await miro.board.getUserInfo()).id;
    } catch {
      /* Web SDK unavailable — skip doc resolution below */
    }
    if (userId) {
      for (const [id, doc] of docCandidates) {
        const content = await getDocumentText(id, userId);
        if (content) stickies.set(id, { ...doc, content });
      }
    }
  }

  return [...stickies.values()];
}

/** Live sticky-note selection, frame-expanded (see `collectSelectedStickies`),
 *  refreshed on selection change. The raw list, ordered/joined by callers as
 *  needed — `useSelectedStickyText` below is the common "just give me the
 *  prompt text" wrapper over this. */
export function useBoardStickies(): SelectedSticky[] {
  const [stickies, setStickies] = useState<SelectedSticky[]>([]);

  useEffect(() => {
    let mounted = true;
    const apply = () => {
      collectSelectedStickies()
        .then((s) => mounted && setStickies(s))
        .catch((e) => console.warn('[boardInputs] collectSelectedStickies failed', e));
    };
    apply();
    const handler = () => apply();
    miro.board.ui.on('selection:update', handler);
    return () => {
      mounted = false;
      try {
        miro.board.ui.off('selection:update', handler);
      } catch {
        /* older SDKs */
      }
    };
  }, []);

  return stickies;
}

/** Live prompt seed from the current sticky selection: text + the anchor sticky. */
export function useSelectedStickyText(): { text: string; anchorId?: string } {
  const stickies = useBoardStickies();

  return useMemo(() => {
    const ordered = [...stickies].sort((a, b) => (a.x ?? 0) - (b.x ?? 0));
    return { text: orderedStickyText(ordered), anchorId: ordered[0]?.id };
  }, [stickies]);
}
