// The placeholder is generated SVG built by string concatenation, which means
// two things can go wrong quietly: unescaped upstream text corrupts the
// document so the board shows nothing at all, and unwrapped text runs off the
// edge of the card. Both are only visible by decoding what we actually emit,
// so that is what these do.

import { describe, it, expect } from 'vitest';
import { makePlaceholderDataUrl, wrapPlaceholderText } from './boardHelpers';

/** Decode a `data:image/svg+xml;base64,…` back to its SVG source. */
function svgOf(dataUrl: string): string {
  const base64 = dataUrl.split(',')[1];
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

const FAL_ERROR =
  'video_urls.0: Video dimensions are too small. Minimum dimensions are 300x300 pixels. Found 320x240 pixels.';

describe('wrapPlaceholderText', () => {
  it('breaks on whitespace within the line budget', () => {
    const lines = wrapPlaceholderText('the quick brown fox jumps', 10, 5);
    expect(lines).toEqual(['the quick', 'brown fox', 'jumps']);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(10);
  });

  it('hard-splits a token longer than the line rather than overflowing', () => {
    const lines = wrapPlaceholderText('https://v3b.fal.media/files/b/0aa93f05/output.mp4', 20, 5);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(20);
    expect(lines.length).toBeGreaterThan(1);
  });

  it('truncates with an ellipsis past maxLines', () => {
    const lines = wrapPlaceholderText(FAL_ERROR, 20, 2);
    expect(lines).toHaveLength(2);
    expect(lines[1].endsWith('…')).toBe(true);
  });

  it('adds no ellipsis when the text fits inside the line budget', () => {
    const lines = wrapPlaceholderText('one two three', 20, 5);
    expect(lines).toEqual(['one two three']);
  });

  it('returns nothing for empty or whitespace-only text', () => {
    expect(wrapPlaceholderText('', 20, 5)).toEqual([]);
    expect(wrapPlaceholderText('   \n  ', 20, 5)).toEqual([]);
  });
});

describe('makePlaceholderDataUrl', () => {
  it('still renders the plain in-progress card when given no detail', () => {
    const svg = svgOf(makePlaceholderDataUrl('16:9', 'Generating video…'));
    expect(svg).toContain('Generating video…');
    // Dimensions line and progress bar belong to the in-progress card.
    expect(svg).toContain('×');
    expect(svg).toContain('fill-opacity="0.5"');
  });

  it('renders the failure detail across several lines', () => {
    const svg = svgOf(makePlaceholderDataUrl('16:9', 'Failed', FAL_ERROR));
    expect(svg).toContain('Failed');
    expect(svg).toContain('Minimum dimensions');
    // More than the label alone means the message really was laid out.
    const textNodes = svg.match(/<text/g) ?? [];
    expect(textNodes.length).toBeGreaterThan(2);
  });

  it('drops the progress bar on a failure — there is no progress to suggest', () => {
    const svg = svgOf(makePlaceholderDataUrl('16:9', 'Failed', FAL_ERROR));
    expect(svg).not.toContain('fill-opacity="0.5"');
  });

  it('escapes markup in the detail so the SVG stays valid', () => {
    const svg = svgOf(makePlaceholderDataUrl('1:1', 'Failed', 'bad <input> & "quotes"'));
    expect(svg).toContain('&lt;input&gt;');
    expect(svg).toContain('&amp;');
    expect(svg).not.toContain('<input>');
  });

  it('escapes the label too, not just the detail', () => {
    const svg = svgOf(makePlaceholderDataUrl('1:1', 'a & b'));
    expect(svg).toContain('a &amp; b');
  });

  it('parses as real XML after an error message goes through it', () => {
    const svg = svgOf(makePlaceholderDataUrl('16:9', 'Failed', 'why <b>& how</b>'));
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    expect(doc.querySelector('parsererror')).toBeNull();
  });

  it('survives a very long message without producing an enormous document', () => {
    const svg = svgOf(makePlaceholderDataUrl('16:9', 'Failed', 'word '.repeat(400)));
    const textNodes = svg.match(/<text/g) ?? [];
    // Label + at most MAX_DETAIL_LINES.
    expect(textNodes.length).toBeLessThanOrEqual(6);
  });
});
