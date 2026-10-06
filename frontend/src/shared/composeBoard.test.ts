// findComposeByCid: the URL narrows, the metadata decides — an embed with a
// copied compose URL but no (or someone else's) metadata must not match.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { COMPOSE_METADATA_KEY } from './compose';
import { findComposeByCid } from './composeBoard';

const CID = '3f2b8c1e-9a4d-4e7b-8c2a-1d5e6f7a8b9c';
const OTHER = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const page = (cid: string) =>
  `https://charliewinters.github.io/fal-miro/embed-compose.html?url=x&w=1920&h=1080&cid=${cid}&cb=1`;

function embed(id: string, url: string, meta: unknown, at = { x: 10, y: 20, width: 1200, height: 800 }) {
  return {
    id, type: 'embed', url, ...at,
    getMetadata: vi.fn(async (key: string) => (key === COMPOSE_METADATA_KEY ? meta : undefined)),
    setMetadata: vi.fn(),
  };
}

function board(items: unknown[]) {
  (globalThis as unknown as { miro: unknown }).miro = { board: { get: vi.fn(async () => items) } };
}

afterEach(() => {
  delete (globalThis as unknown as { miro?: unknown }).miro;
});

describe('findComposeByCid', () => {
  it('finds the embed whose URL and metadata both carry the cid', async () => {
    board([
      embed('a', page(OTHER), { v: 1, cid: OTHER, source: 'https://f/a.webm' }),
      embed('b', page(CID), { v: 1, cid: CID, source: 'https://f/b.webm' }, { x: 5, y: 6, width: 7, height: 8 }),
    ]);
    expect(await findComposeByCid(CID)).toEqual({ x: 5, y: 6, width: 7, height: 8 });
  });

  it('ignores a copied URL with no metadata', async () => {
    board([embed('fake', page(CID), undefined)]);
    expect(await findComposeByCid(CID)).toBeNull();
  });

  it('ignores metadata that names a different cid', async () => {
    board([embed('fake', page(CID), { v: 1, cid: OTHER, source: 'https://f/a.webm' })]);
    expect(await findComposeByCid(CID)).toBeNull();
  });

  it('does not read metadata for embeds that are not compose pages', async () => {
    const video = embed('v', 'https://charliewinters.github.io/fal-miro/embed-video.html?url=x', undefined);
    board([video]);
    expect(await findComposeByCid(CID)).toBeNull();
    expect(video.getMetadata).not.toHaveBeenCalled();
  });
});
