import { describe, expect, it } from 'vitest';
import { extractOutputUrls } from './falOutput';

describe('extractOutputUrls', () => {
  it('finds a Hunyuan Motion FBX and ignores the raw-JSON twin', () => {
    const fbx = 'https://v3b.fal.media/files/b/x/hy_motion_000.fbx';
    expect(extractOutputUrls({ fbx_file: { url: fbx }, motion_json: null, seed: 1 })).toEqual([fbx]);
    expect(extractOutputUrls({ fbx_file: null, motion_json: { url: 'https://v3b.fal.media/files/b/x/motion.json' } })).toEqual([]);
  });

  it('still prefers a .glb for 3D results and reads image lists', () => {
    expect(extractOutputUrls({ model_mesh: { url: 'https://x/m.glb' } })).toEqual(['https://x/m.glb']);
    expect(extractOutputUrls({ images: [{ url: 'https://x/a.png' }, { url: 'https://x/b.png' }] })).toEqual([
      'https://x/a.png',
      'https://x/b.png',
    ]);
  });
});
