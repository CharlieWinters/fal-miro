// The board selection, classified by what each item can be used for.
//
// One subscription, and — this is the point — it costs ONE SDK call, at mount.
// Every update after that comes from the `selection:update` event payload,
// which carries the full items. Nothing here polls the board.
//
// That matters because the Web SDK has a call budget we were hitting. The
// previous design mirrored the selection into every input, so each click cost
// 2-5 calls (two hooks each re-running getSelection, plus frame expansion),
// and each anchor change cost ~12 more. Baskets don't follow the selection at
// all — they only read it when the user presses Add — so the steady-state cost
// of clicking around the board is now zero.

import { useEffect, useMemo, useState } from 'react';
import { unwrapAudioEmbedUrl, unwrapVideoEmbedUrl } from '../../lib/api';
import { stripHtml } from '../../shared/boardHelpers';

export type SelectedItem = {
  id: string;
  type: string;
  title?: string;
  content?: string;
  url?: string;
  parentId?: string;
};

/** What a basket can hold. */
export type BasketKind = 'image' | 'video' | 'audio' | 'note';

export type ClassifiedSelection = {
  image: SelectedItem[];
  video: SelectedItem[];
  audio: SelectedItem[];
  note: SelectedItem[];
  /** Ids of any selected frames — the ⋯ menu's "everything on the frame". */
  frameIds: string[];
  /** Everything selected, in board order. */
  all: SelectedItem[];
};

const EMPTY: ClassifiedSelection = { image: [], video: [], audio: [], note: [], frameIds: [], all: [] };

/** Split a raw selection by what each item can feed. */
export function classifySelection(items: SelectedItem[]): ClassifiedSelection {
  const out: ClassifiedSelection = { image: [], video: [], audio: [], note: [], frameIds: [], all: items };
  for (const it of items) {
    if (it.type === 'image') out.image.push(it);
    else if (it.type === 'sticky_note') out.note.push(it);
    else if (it.type === 'frame') out.frameIds.push(it.id);
    else if (it.type === 'embed' && it.url) {
      // Only Fal-generated embeds are usable — an arbitrary embed is neither.
      if (unwrapVideoEmbedUrl(it.url)) out.video.push(it);
      else if (unwrapAudioEmbedUrl(it.url)) out.audio.push(it);
    }
  }
  return out;
}

/** A display label for a selected item: board title, or sticky text. */
export function labelOf(it: SelectedItem): string {
  if (it.type === 'sticky_note') return stripHtml(it.content ?? '').trim();
  return (it.title ?? '').trim();
}

/**
 * The live selection, classified. One SDK call at mount; every later update is
 * free, straight off the event.
 */
export function useBoardSelection(): ClassifiedSelection {
  const [items, setItems] = useState<SelectedItem[] | null>(null);

  useEffect(() => {
    let mounted = true;

    // The only board read in this hook.
    void miro.board
      .getSelection()
      .then((sel) => mounted && setItems(sel as unknown as SelectedItem[]))
      .catch((e) => console.warn('[boardSelection] initial getSelection failed:', e));

    const handler = (event: { items: unknown[] }) => {
      if (mounted) setItems(event.items as SelectedItem[]);
    };
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

  return useMemo(() => (items ? classifySelection(items) : EMPTY), [items]);
}
