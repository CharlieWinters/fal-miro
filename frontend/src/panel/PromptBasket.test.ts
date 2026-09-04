// The prompt is assembled from two sources — sticky notes in basket order, then
// whatever the user typed. The rule that matters is that the two are
// *concatenated, never merged*: the note text is passed through verbatim, in
// order, so what the user sees in the basket is what the model receives.

import { describe, it, expect } from 'vitest';
import { assemblePrompt } from './PromptBasket';
import type { Basket, BasketItem } from './hooks/basket';

/** A Basket with only the field assemblePrompt reads. */
function basketOf(...labels: string[]): Basket {
  const items: BasketItem[] = labels.map((label, i) => ({ uid: i + 1, id: `n${i}`, label }));
  return { items } as Basket;
}

describe('assemblePrompt', () => {
  it('puts notes first, in basket order, then the typed text', () => {
    expect(assemblePrompt(basketOf('a knight', 'in a field'), 'at dawn')).toBe(
      'a knight in a field at dawn',
    );
  });

  it('respects order — reordering the basket reorders the prompt', () => {
    expect(assemblePrompt(basketOf('second', 'first'), '')).toBe('second first');
  });

  it('works with only notes, or only typed text', () => {
    expect(assemblePrompt(basketOf('just a note'), '')).toBe('just a note');
    expect(assemblePrompt(basketOf(), 'just typed')).toBe('just typed');
  });

  it('is empty when both sides are', () => {
    expect(assemblePrompt(basketOf(), '')).toBe('');
    expect(assemblePrompt(basketOf('', '  '), '   ')).toBe('');
  });

  it('drops blank notes rather than leaving double spaces', () => {
    expect(assemblePrompt(basketOf('a knight', '   ', 'in a field'), '')).toBe('a knight in a field');
  });

  it('trims each part but never rewrites the text inside a note', () => {
    // Punctuation, casing and internal spacing are the user's business.
    expect(assemblePrompt(basketOf('  A Knight,  armoured  '), ' at dawn. ')).toBe(
      'A Knight,  armoured at dawn.',
    );
  });

  it('preserves @tokens verbatim so they can still resolve', () => {
    expect(assemblePrompt(basketOf('@Image1 wearing @Image2'), 'in @Image3 style')).toBe(
      '@Image1 wearing @Image2 in @Image3 style',
    );
  });

  it('tolerates a null or undefined label without throwing', () => {
    const b = { items: [{ uid: 1, id: 'a', label: null }, { uid: 2, id: 'b', label: 'ok' }] } as unknown as Basket;
    expect(assemblePrompt(b, 'end')).toBe('ok end');
  });
});
