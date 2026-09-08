// Basket label helpers, plus the stateful hook itself.
//
// The label helpers are only pluralisation, but they are what the Add button
// says on every screen, and "Add 1 audio clips" is the kind of thing that ships.
//
// useBasket is exercised through a tiny React harness (no testing-library) with
// a fake `miro.board`: the hook only touches `miro.board.ui.on/off` for the
// items:delete watcher, and `miro.board.get` for frame expansion, so that is
// all the fake provides. Order is load-bearing for baskets (position IS the
// meaning — @Image1 is whatever sits in row 1), so most assertions are on the
// exact sequence of ids.

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// Must exist before the hook module is imported and before any render.
const uiOn = vi.fn();
const uiOff = vi.fn();
const boardGet = vi.fn();
Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  miro: { board: { ui: { on: uiOn, off: uiOff }, get: boardGet } },
});

import { quantity, pluralOf, useBasket, type Basket } from './basket';
import type { BasketKind, ClassifiedSelection, SelectedItem } from './boardSelection';

const KINDS: BasketKind[] = ['image', 'video', 'audio', 'note'];

describe('quantity', () => {
  it('uses the singular for exactly one', () => {
    expect(quantity(1, 'image')).toBe('1 image');
    expect(quantity(1, 'audio')).toBe('1 audio clip');
    expect(quantity(1, 'note')).toBe('1 sticky note');
  });

  it('uses the plural for everything else, including zero', () => {
    expect(quantity(0, 'image')).toBe('0 images');
    expect(quantity(3, 'video')).toBe('3 videos');
    expect(quantity(2, 'audio')).toBe('2 audio clips');
    expect(quantity(5, 'note')).toBe('5 sticky notes');
  });

  it.each(KINDS)('never produces a bare kind name for %s', (kind) => {
    for (const n of [0, 1, 2, 11]) {
      expect(quantity(n, kind)).toMatch(/^\d+ \S/);
    }
  });
});

describe('pluralOf', () => {
  it.each(KINDS)('has a plural for %s', (kind) => {
    expect(pluralOf(kind)).toBeTruthy();
  });

  it('reads naturally in the empty-basket sentence', () => {
    // "Select images on the board and press Add"
    expect(`Select ${pluralOf('image')} on the board`).toBe('Select images on the board');
    expect(`Select ${pluralOf('note')} on the board`).toBe('Select sticky notes on the board');
  });
});

// ---------------------------------------------------------------------------
// useBasket
// ---------------------------------------------------------------------------

type Rendered<T> = { result: { current: T }; unmount: () => void };

/** Minimal renderHook: mounts a component that calls `use` and exposes the latest value. */
function renderHook<T>(use: () => T): Rendered<T> {
  const result = { current: undefined as unknown as T };
  function Probe(): null {
    result.current = use();
    return null;
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root: Root;
  act(() => {
    root = createRoot(container);
    root.render(createElement(Probe));
  });
  return {
    result,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

const img = (id: string, title = id): SelectedItem => ({ id, type: 'image', title });
const vid = (id: string, title = id): SelectedItem => ({ id, type: 'embed', title, url: 'https://x/v' });

function selectionOf(over: Partial<ClassifiedSelection> = {}): ClassifiedSelection {
  const image = over.image ?? [];
  const video = over.video ?? [];
  const audio = over.audio ?? [];
  const note = over.note ?? [];
  return {
    image,
    video,
    audio,
    note,
    frameIds: over.frameIds ?? [],
    all: over.all ?? [...image, ...video, ...audio, ...note],
  };
}

function ids(b: Basket): string[] {
  return b.items.map((i) => i.id);
}

/** The items:delete handler the hook registered, as the board would call it. */
function deleteHandler(): (event: { items?: Array<{ id: string }> }) => void {
  const call = uiOn.mock.calls.find(([event]) => event === 'items:delete');
  if (!call) throw new Error('useBasket did not subscribe to items:delete');
  return call[1] as (event: { items?: Array<{ id: string }> }) => void;
}

describe('useBasket', () => {
  let mounted: Rendered<Basket> | null = null;

  const mount = (kind: BasketKind, selection: ClassifiedSelection) => {
    mounted = renderHook(() => useBasket(kind, selection));
    return mounted.result;
  };

  beforeEach(() => {
    uiOn.mockClear();
    uiOff.mockClear();
    boardGet.mockReset();
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
  });

  it('starts empty, reports the selection count for its own kind, and subscribes to items:delete', () => {
    const r = mount('image', selectionOf({ image: [img('a'), img('b')], video: [vid('v')] }));
    expect(r.current.items).toEqual([]);
    expect(r.current.kind).toBe('image');
    expect(r.current.selectionCount).toBe(2);
    expect(r.current.undo).toBeNull();
    expect(r.current.hasMissing).toBe(false);
    expect(uiOn).toHaveBeenCalledWith('items:delete', expect.any(Function));
  });

  describe('addSelection', () => {
    it('appends the selected items of this kind, in selection order, with their titles', () => {
      const r = mount('image', selectionOf({ image: [img('a', 'Hero'), img('b', ' Texture ')] }));
      act(() => r.current.addSelection());
      expect(ids(r.current)).toEqual(['a', 'b']);
      expect(r.current.items.map((i) => i.label)).toEqual(['Hero', 'Texture']);
      expect(r.current.undo).toEqual({ uids: r.current.items.map((i) => i.uid), text: 'Added 2 images from the selection' });
    });

    it('reads selection[kind] — a video basket ignores selected images', () => {
      const r = mount('video', selectionOf({ image: [img('a')], video: [vid('v1'), vid('v2')] }));
      expect(r.current.selectionCount).toBe(2);
      act(() => r.current.addSelection());
      expect(ids(r.current)).toEqual(['v1', 'v2']);
      expect(r.current.undo?.text).toBe('Added 2 videos from the selection');
    });

    it('uses the singular in the undo text for one item', () => {
      const r = mount('audio', selectionOf({ audio: [vid('s')] }));
      act(() => r.current.addSelection());
      expect(r.current.undo?.text).toBe('Added 1 audio clip from the selection');
    });

    it('does nothing when the selection holds none of this kind', () => {
      const r = mount('image', selectionOf({ video: [vid('v')] }));
      act(() => r.current.addSelection());
      expect(r.current.items).toEqual([]);
      expect(r.current.undo).toBeNull();
    });

    it('de-duplicates by board id — adding the same item twice yields one row', () => {
      const r = mount('image', selectionOf({ image: [img('a'), img('b')] }));
      act(() => r.current.addSelection());
      const before = r.current.items;
      act(() => r.current.addSelection());
      expect(ids(r.current)).toEqual(['a', 'b']);
      // Same rows, same uids — nothing was re-created.
      expect(r.current.items).toEqual(before);
    });

    it('appends only the new ids when the selection partly overlaps the basket', () => {
      const r = mount('image', selectionOf({ image: [img('a'), img('b')] }));
      act(() => r.current.addSelection());
      act(() => r.current.replace([{ id: 'a', title: 'a' }]));
      act(() => r.current.addSelection());
      expect(ids(r.current)).toEqual(['a', 'b']);
      expect(r.current.undo?.text).toBe('Added 2 images from the selection');
    });

    it('gives every row a distinct uid', () => {
      const r = mount('image', selectionOf({ image: [img('a'), img('b'), img('c')] }));
      act(() => r.current.addSelection());
      const uids = r.current.items.map((i) => i.uid);
      expect(new Set(uids).size).toBe(3);
    });
  });

  describe('addUrl', () => {
    it('adds a pasted URL with the id doubling as the url and a scheme-less label', () => {
      const r = mount('image', selectionOf());
      act(() => r.current.addUrl('  https://cdn.example.com/a.png '));
      expect(r.current.items).toHaveLength(1);
      expect(r.current.items[0].id).toBe('https://cdn.example.com/a.png');
      expect(r.current.items[0].label).toBe('cdn.example.com/a.png');
      expect(r.current.undo?.text).toBe('Added a pasted URL');
    });

    it('caps the label at 40 characters', () => {
      const r = mount('image', selectionOf());
      act(() => r.current.addUrl(`https://cdn.example.com/${'x'.repeat(100)}.png`));
      expect(r.current.items[0].label).toHaveLength(40);
    });

    it('ignores blank input and de-duplicates a repeated URL', () => {
      const r = mount('image', selectionOf());
      act(() => r.current.addUrl('   '));
      expect(r.current.items).toEqual([]);
      act(() => r.current.addUrl('https://x/a.png'));
      act(() => r.current.addUrl('https://x/a.png'));
      expect(ids(r.current)).toEqual(['https://x/a.png']);
    });
  });

  describe('remove', () => {
    it('drops exactly the row with that uid and clears the undo', () => {
      const r = mount('image', selectionOf({ image: [img('a'), img('b'), img('c')] }));
      act(() => r.current.addSelection());
      const target = r.current.items[1].uid;
      act(() => r.current.remove(target));
      expect(ids(r.current)).toEqual(['a', 'c']);
      expect(r.current.undo).toBeNull();
    });

    it('is a no-op for an unknown uid', () => {
      const r = mount('image', selectionOf({ image: [img('a')] }));
      act(() => r.current.addSelection());
      act(() => r.current.remove(999999));
      expect(ids(r.current)).toEqual(['a']);
    });
  });

  describe('move', () => {
    const seed = () => {
      const r = mount('image', selectionOf({ image: [img('a'), img('b'), img('c'), img('d')] }));
      act(() => r.current.addSelection());
      return r;
    };

    it('moves a row down: 0 → 2', () => {
      const r = seed();
      act(() => r.current.move(0, 2));
      expect(ids(r.current)).toEqual(['b', 'c', 'a', 'd']);
    });

    it('moves a row up: 3 → 0', () => {
      const r = seed();
      act(() => r.current.move(3, 0));
      expect(ids(r.current)).toEqual(['d', 'a', 'b', 'c']);
    });

    it('moves to the last position: 1 → 3', () => {
      const r = seed();
      act(() => r.current.move(1, 3));
      expect(ids(r.current)).toEqual(['a', 'c', 'd', 'b']);
    });

    it('swaps neighbours: 1 → 2', () => {
      const r = seed();
      act(() => r.current.move(1, 2));
      expect(ids(r.current)).toEqual(['a', 'c', 'b', 'd']);
    });

    it('keeps each row’s uid attached to its id through a reorder', () => {
      const r = seed();
      const uidOf = Object.fromEntries(r.current.items.map((i) => [i.id, i.uid]));
      act(() => r.current.move(0, 3));
      for (const row of r.current.items) expect(row.uid).toBe(uidOf[row.id]);
      expect(r.current.items).toHaveLength(4);
    });

    it('ignores a same-index or out-of-range move', () => {
      const r = seed();
      const before = r.current.items;
      act(() => r.current.move(1, 1));
      act(() => r.current.move(-1, 0));
      act(() => r.current.move(0, 4));
      act(() => r.current.move(7, 0));
      expect(r.current.items).toEqual(before);
    });

    it('clears the undo — a reorder is not something to undo as an add', () => {
      const r = seed();
      expect(r.current.undo).not.toBeNull();
      act(() => r.current.move(0, 1));
      expect(r.current.undo).toBeNull();
    });
  });

  describe('replace', () => {
    it('swaps the whole basket for the given rows, trimming titles and keeping missing flags', () => {
      const r = mount('image', selectionOf({ image: [img('a')] }));
      act(() => r.current.addSelection());
      act(() =>
        r.current.replace([
          { id: 'x', title: '  Ex  ' },
          { id: 'y', missing: true },
          { id: 'z', title: 'Zed' },
        ]),
      );
      expect(ids(r.current)).toEqual(['x', 'y', 'z']);
      expect(r.current.items.map((i) => i.label)).toEqual(['Ex', '', 'Zed']);
      expect(r.current.items[1].missing).toBe(true);
      expect(r.current.hasMissing).toBe(true);
      expect(r.current.undo).toBeNull();
    });

    it('replacing with an empty list empties the basket', () => {
      const r = mount('image', selectionOf({ image: [img('a')] }));
      act(() => r.current.addSelection());
      act(() => r.current.replace([]));
      expect(r.current.items).toEqual([]);
    });
  });

  describe('applyUndo', () => {
    it('removes exactly the rows the last add put in and clears the undo', () => {
      const r = mount('image', selectionOf({ image: [img('a'), img('b')] }));
      act(() => r.current.addUrl('https://x/keep.png'));
      act(() => r.current.addSelection());
      expect(ids(r.current)).toEqual(['https://x/keep.png', 'a', 'b']);
      act(() => r.current.applyUndo());
      expect(ids(r.current)).toEqual(['https://x/keep.png']);
      expect(r.current.undo).toBeNull();
    });

    it('is a no-op when there is nothing to undo', () => {
      const r = mount('image', selectionOf({ image: [img('a')] }));
      act(() => r.current.addSelection());
      act(() => r.current.remove(r.current.items[0].uid));
      act(() => r.current.addUrl('https://x/a.png'));
      act(() => r.current.move(0, 0));
      // move(0,0) is ignored but still clears undo.
      expect(r.current.undo).toBeNull();
      act(() => r.current.applyUndo());
      expect(ids(r.current)).toEqual(['https://x/a.png']);
    });

    it('undoes only the second add when two adds happened in a row', () => {
      const r = mount('image', selectionOf({ image: [img('a')] }));
      act(() => r.current.addSelection());
      act(() => r.current.addUrl('https://x/b.png'));
      act(() => r.current.applyUndo());
      expect(ids(r.current)).toEqual(['a']);
    });
  });

  describe('items:delete watcher', () => {
    it('marks a deleted board item missing rather than dropping the row', () => {
      const r = mount('image', selectionOf({ image: [img('a'), img('b')] }));
      act(() => r.current.addSelection());
      act(() => deleteHandler()({ items: [{ id: 'a' }] }));
      expect(ids(r.current)).toEqual(['a', 'b']);
      expect(r.current.items[0].missing).toBe(true);
      expect(r.current.items[1].missing).toBeUndefined();
      expect(r.current.hasMissing).toBe(true);
    });

    it('ignores deletions of items that are not in the basket', () => {
      const r = mount('image', selectionOf({ image: [img('a')] }));
      act(() => r.current.addSelection());
      const before = r.current.items;
      act(() => deleteHandler()({ items: [{ id: 'other' }] }));
      act(() => deleteHandler()({ items: [] }));
      act(() => deleteHandler()({}));
      expect(r.current.items).toBe(before);
      expect(r.current.hasMissing).toBe(false);
    });

    it('flags several rows at once when several items are deleted', () => {
      const r = mount('image', selectionOf({ image: [img('a'), img('b'), img('c')] }));
      act(() => r.current.addSelection());
      act(() => deleteHandler()({ items: [{ id: 'a' }, { id: 'c' }] }));
      expect(r.current.items.map((i) => Boolean(i.missing))).toEqual([true, false, true]);
    });

    it('removeMissing then clears only the flagged rows', () => {
      const r = mount('image', selectionOf({ image: [img('a'), img('b'), img('c')] }));
      act(() => r.current.addSelection());
      act(() => deleteHandler()({ items: [{ id: 'b' }] }));
      act(() => r.current.removeMissing());
      expect(ids(r.current)).toEqual(['a', 'c']);
      expect(r.current.hasMissing).toBe(false);
      expect(r.current.undo).toBeNull();
    });

    it('unsubscribes with the same handler on unmount', () => {
      mount('image', selectionOf());
      const handler = deleteHandler();
      mounted!.unmount();
      mounted = null;
      expect(uiOff).toHaveBeenCalledWith('items:delete', handler);
    });
  });

  describe('addFromFrame', () => {
    it('adds the items of this kind that sit inside the selected frame', async () => {
      boardGet.mockResolvedValue([
        { id: 'in1', type: 'image', title: 'In 1', parentId: 'frame1' },
        { id: 'out', type: 'image', title: 'Out', parentId: 'frame2' },
        { id: 'in2', type: 'image', title: 'In 2', parentId: 'frame1' },
      ]);
      const r = mount('image', selectionOf({ frameIds: ['frame1'] }));
      await act(async () => {
        await r.current.addFromFrame();
      });
      expect(boardGet).toHaveBeenCalledWith({ type: 'image' });
      expect(ids(r.current)).toEqual(['in1', 'in2']);
      expect(r.current.undo?.text).toBe('Added 2 images from the frame');
      expect(r.current.loading).toBe(false);
    });

    it('does nothing when no frame is selected', async () => {
      const r = mount('image', selectionOf({ image: [img('a')] }));
      await act(async () => {
        await r.current.addFromFrame();
      });
      expect(boardGet).not.toHaveBeenCalled();
      expect(r.current.items).toEqual([]);
    });
  });
});
