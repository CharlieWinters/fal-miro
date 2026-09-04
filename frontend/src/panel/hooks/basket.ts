// A reference basket — an ordered list of board items the user builds.
//
// This replaces the previous "binding" model, which mirrored the board
// selection into each input behind a four-way mode switch. That failed in
// testing: modes meant the panel could silently stop following what you were
// doing (auto-pin), and there was no direct way to add one more item, remove
// one, or reorder. A basket has no modes because there is nothing to mirror —
// the list IS the state, and every change to it is something the user did.
//
// Order is the only structure that exists, and it is load-bearing: the models
// take a flat `image_urls` array with no notion of a subject, so position is
// the whole meaning. Seedance addresses items as @Image1…@ImageN; the app's
// own pipelines say "the garment in the first image". Reordering renumbers.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { unwrapAudioEmbedUrl, unwrapVideoEmbedUrl } from '../../lib/api';
import { getConnectedResources } from '../../shared/boardHelpers';
import { labelOf, type BasketKind, type ClassifiedSelection, type SelectedItem } from './boardSelection';

export type BasketItem = {
  /** Stable row identity. Separate from `id` so React keys survive reorders. */
  uid: number;
  /** Board item id. */
  id: string;
  label: string;
  /** The board object has gone — flagged rather than silently dropped. */
  missing?: boolean;
};

export type BasketUndo = { uids: number[]; text: string } | null;

export type Basket = {
  kind: BasketKind;
  items: BasketItem[];
  /** How many items of this kind the current selection holds — drives the
   *  Add button's label, and costs nothing (see boardSelection.ts). */
  selectionCount: number;
  addSelection: () => void;
  addFromConnectors: () => Promise<void>;
  addFromFrame: () => Promise<void>;
  addUrl: (url: string) => void;
  remove: (uid: number) => void;
  removeMissing: () => void;
  move: (from: number, to: number) => void;
  /** Replace the whole basket — used when a settings card is reopened. */
  replace: (items: Array<{ id: string; title?: string; missing?: boolean }>) => void;
  undo: BasketUndo;
  applyUndo: () => void;
  /** Busy while an explicit board read is in flight. */
  loading: boolean;
  hasMissing: boolean;
};

const PLURAL: Record<BasketKind, string> = {
  image: 'images',
  video: 'videos',
  audio: 'audio clips',
  note: 'sticky notes',
};
const SINGULAR: Record<BasketKind, string> = {
  image: 'image',
  video: 'video',
  audio: 'audio clip',
  note: 'sticky note',
};

export function quantity(n: number, kind: BasketKind): string {
  return `${n} ${n === 1 ? SINGULAR[kind] : PLURAL[kind]}`;
}
export const pluralOf = (kind: BasketKind) => PLURAL[kind];

let nextUid = 1;

export function useBasket(kind: BasketKind, selection: ClassifiedSelection): Basket {
  const [items, setItems] = useState<BasketItem[]>([]);
  const [undo, setUndo] = useState<BasketUndo>(null);
  const [loading, setLoading] = useState(false);
  // Guards against a slow connector read landing after the user moved on.
  const runId = useRef(0);

  const candidates = selection[kind];

  /** Append, skipping anything already in the basket, and stage an undo. */
  const append = useCallback((incoming: Array<{ id: string; label: string }>, text: string) => {
    setItems((cur) => {
      const have = new Set(cur.map((i) => i.id));
      const added = incoming.filter((i) => !have.has(i.id)).map((i) => ({ uid: nextUid++, id: i.id, label: i.label }));
      if (!added.length) return cur;
      setUndo({ uids: added.map((a) => a.uid), text });
      return [...cur, ...added];
    });
  }, []);

  const addSelection = useCallback(() => {
    if (!candidates.length) return;
    append(
      candidates.map((it: SelectedItem) => ({ id: it.id, label: labelOf(it) })),
      `Added ${quantity(candidates.length, kind)} from the selection`,
    );
  }, [candidates, kind, append]);

  /**
   * The selected item plus everything wired to it. Explicit and one-shot — it
   * appends and stops. Nothing subscribes, so there is no anchor to get stuck
   * on, which is what made the previous "Connected" mode feel like a trap.
   *
   * The anchor itself goes in first, when it is of this basket's kind: if you
   * selected the hero image and asked for its connectors, you almost certainly
   * want the hero image too, and it being @Image1 matches how the prompt
   * usually reads. A video basket ignores an image anchor.
   */
  const addFromConnectors = useCallback(async () => {
    const anchor = selection.all.length === 1 ? selection.all[0] : null;
    if (!anchor) return;
    const run = ++runId.current;
    setLoading(true);
    try {
      const res = await getConnectedResources(anchor.id);
      if (run !== runId.current) return;
      const picked =
        kind === 'image' ? res.images : kind === 'video' ? res.videos : kind === 'audio' ? res.audios : [];
      const notes = kind === 'note' ? res.stickies.map((s) => ({ id: s.id, label: s.content })) : [];
      const connected = kind === 'note' ? notes : picked.map((p) => ({ id: p.id, label: (p.title ?? '').trim() }));
      // Anchor first, but only when it can actually go in this basket.
      const anchorFits = selection[kind].some((i) => i.id === anchor.id);
      const incoming = anchorFits ? [{ id: anchor.id, label: labelOf(anchor) }, ...connected] : connected;
      if (!incoming.length) {
        setUndo(null);
        return;
      }
      const anchorName = labelOf(anchor) || 'the selected item';
      append(
        incoming,
        anchorFits
          ? `Added ${anchorName} and ${quantity(connected.length, kind)} wired to it`
          : `Added ${quantity(connected.length, kind)} from connectors of ${anchorName}`,
      );
    } catch (e) {
      console.warn('[basket] addFromConnectors failed', e);
    } finally {
      if (run === runId.current) setLoading(false);
    }
  }, [selection, kind, append]);

  /**
   * Everything of this kind inside the selected frame. Deliberately an
   * explicit action rather than automatic frame expansion — the old
   * always-on version ran a board query on every click.
   */
  const addFromFrame = useCallback(async () => {
    const frameId = selection.frameIds[0];
    if (!frameId) return;
    const run = ++runId.current;
    setLoading(true);
    try {
      const type = kind === 'note' ? 'sticky_note' : kind === 'image' ? 'image' : 'embed';
      const get = miro.board.get as unknown as (o: { type: string }) => Promise<SelectedItem[]>;
      const all = await get({ type });
      if (run !== runId.current) return;
      const inFrame = all.filter((i) => i.parentId === frameId);
      const usable = kind === 'video' || kind === 'audio' ? classifyEmbeds(inFrame, kind) : inFrame;
      if (!usable.length) {
        setUndo(null);
        return;
      }
      append(
        usable.map((i) => ({ id: i.id, label: labelOf(i) })),
        `Added ${quantity(usable.length, kind)} from the frame`,
      );
    } catch (e) {
      console.warn('[basket] addFromFrame failed', e);
    } finally {
      if (run === runId.current) setLoading(false);
    }
  }, [selection.frameIds, kind, append]);

  /** A URL with no board item behind it — id doubles as the url. */
  const addUrl = useCallback(
    (url: string) => {
      const trimmed = url.trim();
      if (!trimmed) return;
      append([{ id: trimmed, label: trimmed.replace(/^https?:\/\//, '').slice(0, 40) }], 'Added a pasted URL');
    },
    [append],
  );

  // A basket holds board item ids, so an item deleted on the board leaves a
  // row pointing at nothing. Flag it rather than dropping it silently: the
  // user may have deleted it by accident, and a row vanishing on its own is
  // exactly the kind of invisible change baskets exist to avoid. Driven by the
  // board's own delete event, so it costs no SDK calls.
  useEffect(() => {
    const handler = (event: { items?: Array<{ id: string }> }) => {
      const gone = new Set((event?.items ?? []).map((i) => i.id));
      if (!gone.size) return;
      setItems((cur) => (cur.some((i) => gone.has(i.id) && !i.missing)
        ? cur.map((i) => (gone.has(i.id) ? { ...i, missing: true } : i))
        : cur));
    };
    miro.board.ui.on('items:delete', handler);
    return () => {
      try {
        miro.board.ui.off('items:delete', handler);
      } catch {
        /* older SDKs */
      }
    };
  }, []);

  const remove = useCallback((uid: number) => {
    setItems((cur) => cur.filter((i) => i.uid !== uid));
    setUndo(null);
  }, []);

  const removeMissing = useCallback(() => {
    setItems((cur) => cur.filter((i) => !i.missing));
    setUndo(null);
  }, []);

  const move = useCallback((from: number, to: number) => {
    setItems((cur) => {
      if (from === to || from < 0 || to < 0 || from >= cur.length || to >= cur.length) return cur;
      const next = [...cur];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
    setUndo(null);
  }, []);

  const replace = useCallback((incoming: Array<{ id: string; title?: string; missing?: boolean }>) => {
    setItems(
      incoming.map((i) => ({ uid: nextUid++, id: i.id, label: (i.title ?? '').trim(), missing: i.missing })),
    );
    setUndo(null);
  }, []);

  const applyUndo = useCallback(() => {
    setUndo((u) => {
      if (u) {
        const drop = new Set(u.uids);
        setItems((cur) => cur.filter((i) => !drop.has(i.uid)));
      }
      return null;
    });
  }, []);

  return useMemo(
    () => ({
      kind,
      items,
      selectionCount: candidates.length,
      addSelection,
      addFromConnectors,
      addFromFrame,
      addUrl,
      remove,
      removeMissing,
      move,
      replace,
      undo,
      applyUndo,
      loading,
      hasMissing: items.some((i) => i.missing),
    }),
    [
      kind, items, candidates.length, addSelection, addFromConnectors, addFromFrame,
      addUrl, remove, removeMissing, move, replace, undo, applyUndo, loading,
    ],
  );
}

/** Frame expansion returns raw embeds; keep only the Fal ones of this kind. */
function classifyEmbeds(items: SelectedItem[], kind: 'video' | 'audio'): SelectedItem[] {
  return items.filter((i) => {
    if (i.type !== 'embed' || !i.url) return false;
    return kind === 'video' ? Boolean(unwrapVideoEmbedUrl(i.url)) : Boolean(unwrapAudioEmbedUrl(i.url));
  });
}
