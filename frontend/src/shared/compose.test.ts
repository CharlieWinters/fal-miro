// The embed-compose channel. Like the node channel, anything on this origin
// can post to the headless iframe, so the parser is the boundary: it must
// refuse what isn't a well-formed ping or a sane video placement.
import { describe, expect, it } from 'vitest';
import { COMPOSE_MAX_BYTES, COMPOSE_MSG, parseComposeRequest, placementFor } from './compose';

const video = (size = 1000, type = 'video/mp4') => new Blob([new Uint8Array(size)], { type });
const place = (over: Record<string, unknown> = {}) => ({
  type: COMPOSE_MSG.place, v: 1, rid: 'cabc123', cid: 'skater', video: video(), width: 1920, height: 1080, ...over,
});

describe('parseComposeRequest', () => {
  it('accepts a ping', () => {
    expect(parseComposeRequest({ type: COMPOSE_MSG.ping, v: 1, rid: 'cabc123' })).toEqual({
      type: COMPOSE_MSG.ping, v: 1, rid: 'cabc123',
    });
  });

  it('accepts a well-formed placement', () => {
    const req = parseComposeRequest(place());
    expect(req).toMatchObject({ type: COMPOSE_MSG.place, rid: 'cabc123', cid: 'skater', width: 1920, height: 1080 });
  });

  it('drops a malformed cid instead of refusing the placement', () => {
    expect(parseComposeRequest(place({ cid: 'a b"<>' }))).toMatchObject({ cid: null });
    expect(parseComposeRequest(place({ cid: undefined }))).toMatchObject({ cid: null });
  });

  it.each([
    ['not an object', 'fal-compose:place'],
    ['wrong version', place({ v: 2 })],
    ['unknown type', place({ type: 'fal-compose:delete' })],
    ['bad rid', place({ rid: '../x' })],
    ['no video', place({ video: 'https://example.com/a.mp4' })],
    ['empty video', place({ video: video(0) })],
    ['not a video', place({ video: video(10, 'text/html') })],
    ['too large', place({ video: { size: COMPOSE_MAX_BYTES + 1 } })],
    ['tiny canvas', place({ width: 4 })],
    ['huge canvas', place({ height: 100000 })],
    ['non-numeric size', place({ width: '1920' })],
  ])('refuses %s', (_label, data) => {
    expect(parseComposeRequest(data)).toBeNull();
  });
});

describe('placementFor', () => {
  const viewport = { x: 0, y: 0, width: 2000, height: 1000 };

  it('keeps the aspect ratio at an 800px long edge', () => {
    expect(placementFor({ width: 1920, height: 1080 }, null, viewport)).toMatchObject({ width: 800, height: 450 });
    expect(placementFor({ width: 1080, height: 1920 }, null, viewport)).toMatchObject({ width: 450, height: 800 });
  });

  it('lands right of the compose embed, level with it', () => {
    const anchor = { x: 1000, y: 500, width: 1000, height: 1000 };
    const at = placementFor({ width: 1920, height: 1080 }, anchor, viewport);
    // anchor's right edge (1500) + 60 gap + half the new width (400)
    expect(at).toEqual({ x: 1960, y: 500, width: 800, height: 450 });
  });

  it('centres on the viewport when there is no anchor', () => {
    expect(placementFor({ width: 1920, height: 1080 }, null, viewport)).toMatchObject({ x: 1000, y: 500 });
  });
});
