import { describe, expect, it } from 'vitest';
import {
  describePlan,
  isAdLayersResult,
  targetWidthFromRatio,
  miroFontFor,
  miroTextAlign,
  normalizeHexColor,
  planAdLayers,
  type AdLayersResult,
} from './adLayers';

/** The shape Bria returns, trimmed to what the planner reads. */
const SAMPLE: AdLayersResult = {
  canvas: { width: 600, height: 800 },
  font_stylesheets: ['https://fonts.googleapis.com/css2?family=Cinzel'],
  layers: [
    {
      id: 'canvas_background',
      type: 'vector',
      subtype: 'background',
      z_order: 0,
      bbox: { x: 0, y: 0, width: 600, height: 800 },
      style: { background_color: '#DFD7CE' },
    },
    {
      id: 'background_1',
      type: 'image',
      subtype: 'background',
      z_order: 1,
      bbox: { x: 0, y: 0, width: 600, height: 800 },
      asset_path: 'https://temp.bria.ai/x/background_1_erase.png',
    },
    {
      id: 'image_1',
      type: 'image',
      subtype: 'product',
      z_order: 2,
      bbox: { x: 224, y: 74, width: 154, height: 156 },
      asset_path: 'https://temp.bria.ai/x/image_1_cutout.png',
    },
    {
      id: 'text_3_svg',
      type: 'image',
      subtype: 'primary_copy',
      z_order: 7,
      bbox: { x: 170, y: 285, width: 258, height: 42 },
      asset_path: 'https://temp.bria.ai/x/text_3.svg',
      hidden: true,
    },
    {
      id: 'text_3_font',
      type: 'text',
      subtype: 'primary_copy',
      z_order: 8,
      bbox: { x: 170, y: 285, width: 258, height: 42 },
      text: 'Aurora',
      text_style: {
        color: '#604527',
        font_family: 'Cinzel, "Playfair Display", "Times New Roman", serif',
        font_size_px: 55.18,
        text_align: 'center',
        uppercase: true,
      },
    },
  ],
};

describe('isAdLayersResult', () => {
  it('accepts a canvas + layers payload and rejects anything else', () => {
    expect(isAdLayersResult(SAMPLE)).toBe(true);
    expect(isAdLayersResult({ images: [{ url: 'x' }] })).toBe(false);
    expect(isAdLayersResult({ canvas: { width: 1 } })).toBe(false);
    expect(isAdLayersResult(null)).toBe(false);
    expect(isAdLayersResult('{}')).toBe(false);
  });
});

describe('normalizeHexColor', () => {
  it('takes 3- and 6-digit hex, lowercased', () => {
    expect(normalizeHexColor('#DFD7CE')).toBe('#dfd7ce');
    expect(normalizeHexColor(' #abc ')).toBe('#aabbcc');
  });

  it('refuses anything it cannot copy faithfully', () => {
    for (const v of [undefined, '', 'red', 'rgba(0,0,0,.5)', 'linear-gradient(#fff,#000)', '#12345'])
      expect(normalizeHexColor(v), String(v)).toBeNull();
  });
});

describe('miroFontFor', () => {
  it.each([
    ['Cinzel, "Playfair Display", "Times New Roman", serif', 'eb_garamond'],
    ['"Cormorant Garamond", "Times New Roman", serif', 'eb_garamond'],
    ['Montserrat, "Helvetica Neue", sans-serif', 'open_sans'],
    ['"Times New Roman", serif', 'times_new_roman'],
    ['Roboto, Arial, sans-serif', 'roboto'],
    ['"Roboto Condensed", sans-serif', 'roboto_condensed'],
    ['"Courier New", monospace', 'roboto_mono'],
    ['Georgia, serif', 'georgia'],
  ])('maps %s to %s', (stack, font) => {
    expect(miroFontFor(stack)).toBe(font);
  });

  it('falls back by generic family when nothing is recognised', () => {
    expect(miroFontFor('Gibberish, serif')).toBe('pt_serif');
    expect(miroFontFor('Gibberish, sans-serif')).toBe('open_sans');
    expect(miroFontFor(undefined)).toBe('open_sans');
  });

  it('prefers a condensed match over the plain one', () => {
    // Both /roboto condensed/ and /roboto/ match; order in the table decides.
    expect(miroFontFor('"Roboto Condensed", Roboto, sans-serif')).toBe('roboto_condensed');
  });
});

describe('miroTextAlign', () => {
  it('passes through what Miro supports and defaults the rest to left', () => {
    expect(miroTextAlign('center')).toBe('center');
    expect(miroTextAlign('right')).toBe('right');
    expect(miroTextAlign('justify')).toBe('left');
    expect(miroTextAlign(undefined)).toBe('left');
  });
});

describe('planAdLayers', () => {
  const plan = planAdLayers(SAMPLE, 900);

  it('scales the canvas to the requested width', () => {
    expect(plan.scale).toBeCloseTo(1.5, 5);
    expect(plan.size).toEqual({ width: 900, height: 1200 });
  });

  it('keeps the ad backdrop as the backmost shape rather than a frame fill', () => {
    expect(plan.items[0]).toMatchObject({ id: 'canvas_background', kind: 'shape', fillColor: '#dfd7ce', dx: 0, dy: 0, width: 900, height: 1200 });
  });

  it('drops the hidden SVG twin of a live text layer, with a reason', () => {
    expect(plan.items.some((i) => i.id === 'text_3_svg')).toBe(false);
    expect(plan.skipped).toContainEqual({ id: 'text_3_svg', reason: 'the model marked it hidden' });
  });

  it('keeps layers back to front so creation order is the stacking order', () => {
    expect(plan.items.map((i) => i.id)).toEqual(['canvas_background', 'background_1', 'image_1', 'text_3_font']);
  });

  it('converts a top-left bbox into an offset from the assembly centre', () => {
    // background covers the canvas, so it sits dead centre
    expect(plan.items[1]).toMatchObject({ dx: 0, dy: 0, width: 900, height: 1200 });
    // product: centre (224+77, 74+78) px → ×1.5 → (451.5, 228) minus half-size (450, 600)
    expect(plan.items[2].dx).toBeCloseTo(1.5, 5);
    expect(plan.items[2].dy).toBeCloseTo(-372, 5);
    expect(plan.items[2].width).toBeCloseTo(231, 5);
  });

  it('scales the font size and applies uppercase from the style', () => {
    const text = plan.items[3];
    expect(text).toMatchObject({ kind: 'text', content: 'AURORA', color: '#604527', align: 'center', font: 'eb_garamond' });
    expect(text.kind === 'text' && text.fontSize).toBe(83); // 55.18 × 1.5
  });

  it('carries the font stylesheets through for the record', () => {
    expect(plan.fontStylesheets).toEqual(['https://fonts.googleapis.com/css2?family=Cinzel']);
  });

  it('skips layers it cannot place, naming each one', () => {
    const odd = planAdLayers({
      canvas: { width: 100, height: 100 },
      layers: [
        { id: 'no_box', type: 'image', asset_path: 'https://x/a.png' },
        { id: 'zero_box', type: 'image', asset_path: 'https://x/a.png', bbox: { x: 0, y: 0, width: 0, height: 10 } },
        { id: 'no_url', type: 'image', bbox: { x: 0, y: 0, width: 10, height: 10 } },
        { id: 'blank_text', type: 'text', text: '   ', bbox: { x: 0, y: 0, width: 10, height: 10 } },
        { id: 'gradient', type: 'vector', bbox: { x: 0, y: 0, width: 10, height: 10 }, style: { fill: 'linear-gradient(#fff,#000)' } },
        { id: 'martian', type: 'spline', bbox: { x: 0, y: 0, width: 10, height: 10 } },
      ],
    });
    expect(odd.items).toEqual([]);
    expect(odd.skipped.map((s) => s.id)).toEqual(['no_box', 'zero_box', 'no_url', 'blank_text', 'gradient', 'martian']);
    expect(odd.skipped.find((s) => s.id === 'martian')?.reason).toMatch(/spline/);
  });

  it('places a partial-canvas flat colour as a shape where it belongs', () => {
    const p = planAdLayers({
      canvas: { width: 100, height: 100 },
      layers: [{ id: 'band', type: 'vector', bbox: { x: 0, y: 80, width: 100, height: 20 }, style: { background_color: '#123456' } }],
    }, 100);
    expect(p.items).toEqual([{ id: 'band', dx: 0, dy: 40, width: 100, height: 20, kind: 'shape', fillColor: '#123456' }]);
  });

  it('survives an empty or malformed result instead of dividing by zero', () => {
    const p = planAdLayers({});
    expect(p.size.width).toBeGreaterThan(0);
    expect(p.items).toEqual([]);
    expect(Number.isFinite(p.scale)).toBe(true);
  });

  it('matches the source ad width so the rebuild lines up under it', () => {
    for (const w of [600, 720, 1200]) {
      const p = planAdLayers(SAMPLE, w);
      expect(p.size.width, String(w)).toBe(w);
      expect(p.size.height, String(w)).toBe(Math.round((w / 600) * 800));
    }
  });
});

describe('describePlan', () => {
  it('tallies what will be built', () => {
    expect(describePlan(planAdLayers(SAMPLE))).toBe('2 images, 1 text, 1 shape');
    expect(describePlan(planAdLayers({}))).toBe('nothing usable');
  });
});


describe('targetWidthFromRatio', () => {
  it('reads back the width the agent stored, unscaled', () => {
    expect(targetWidthFromRatio('600:800')).toBe(600);
    expect(targetWidthFromRatio('1440:810')).toBe(1440);
  });

  it('falls back to the default for anything unparseable', () => {
    for (const v of [undefined, '', ':800', 'wide:tall', '0:800', '-5:9'])
      expect(targetWidthFromRatio(v), String(v)).toBe(720);
  });
});
