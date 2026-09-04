// Basket label helpers. These are only pluralisation, but they are what the
// Add button says on every screen, and "Add 1 audio clips" is the kind of thing
// that ships.
//
// The stateful part of this module — useBasket, and in particular the
// items:delete watcher that marks a basket entry missing when its board item is
// deleted — is not covered here. It needs a React harness plus a fake
// miro.board, and is currently only exercised by hand on a board.

import { describe, it, expect } from 'vitest';
import { quantity, pluralOf } from './basket';
import type { BasketKind } from './boardSelection';

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
