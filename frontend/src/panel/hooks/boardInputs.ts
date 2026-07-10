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
import { unwrapVideoEmbedUrl } from '../../lib/api';
import { cachedBoardGet, stripHtml } from '../../shared/boardHelpers';
import { useSelectedItems } from './useSelection';

export { useFirstSelected, useSelectedItems } from './useSelection';

/** A board item chosen as an input (id + optional board title). */
export type BoardRef = { id: string; title?: string };

const clean = (t?: string) => (t ?? '').trim() || undefined;

/**
 * Collect input references from the current selection: selected images and video
 * embeds, plus everything inside any selected frame — so you can drop refs into a
 * "References" frame, select it, and grab them all in one click. Ordering follows
 * board read order.
 */
export async function collectBoardReferences(): Promise<{ images: BoardRef[]; videos: BoardRef[] }> {
  const sel = (await miro.board.getSelection()) as Array<{
    id: string;
    type: string;
    url?: string;
    title?: string;
    parentId?: string;
  }>;
  const images = new Map<string, BoardRef>();
  const videos = new Map<string, BoardRef>();
  const frameIds: string[] = [];

  const add = (it: { id: string; type: string; url?: string; title?: string }) => {
    if (it.type === 'image') images.set(it.id, { id: it.id, title: clean(it.title) });
    else if (it.type === 'embed' && it.url && unwrapVideoEmbedUrl(it.url))
      videos.set(it.id, { id: it.id, title: clean(it.title) });
    else if (it.type === 'frame') frameIds.push(it.id);
  };
  sel.forEach(add);

  if (frameIds.length) {
    const [imgs, embeds] = await Promise.all([cachedBoardGet('image'), cachedBoardGet('embed')]);
    for (const it of imgs as Array<BoardRef & { parentId?: string }>) {
      if (it.parentId && frameIds.includes(it.parentId)) images.set(it.id, { id: it.id, title: clean(it.title) });
    }
    for (const it of embeds as Array<BoardRef & { parentId?: string; url?: string }>) {
      if (it.parentId && frameIds.includes(it.parentId) && it.url && unwrapVideoEmbedUrl(it.url))
        videos.set(it.id, { id: it.id, title: clean(it.title) });
    }
  }

  return { images: [...images.values()], videos: [...videos.values()] };
}

/** Live board references (images + video embeds), refreshed on selection change. */
export function useBoardReferences(): { images: BoardRef[]; videos: BoardRef[] } {
  const [refs, setRefs] = useState<{ images: BoardRef[]; videos: BoardRef[] }>({ images: [], videos: [] });

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

/** Live prompt seed from the current sticky selection: text + the anchor sticky. */
export function useSelectedStickyText(): { text: string; anchorId?: string } {
  const stickies = useSelectedItems<{ id: string; content?: string; x?: number }>('sticky_note');
  return useMemo(() => {
    const ordered = [...stickies].sort((a, b) => (a.x ?? 0) - (b.x ?? 0));
    return { text: orderedStickyText(ordered), anchorId: ordered[0]?.id };
  }, [stickies]);
}
