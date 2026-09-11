import { describe, expect, it, vi } from 'vitest';

vi.mock('../lib/api', () => ({
  videoEmbedUrl: (u: string) => `video:${u}`,
  model3dEmbedUrl: (u: string) => `3d:${u}`,
  audioEmbedUrl: (u: string) => `audio:${u}`,
  motionEmbedUrl: (u: string) => `motion:${u}`,
}));

import { classifyOutput } from './genericOutput';

describe('classifyOutput', () => {
  it.each([
    ['https://v3b.fal.media/files/b/x/a.png', 'image'],
    ['https://v3b.fal.media/files/b/x/a.mp4?token=1', 'video'],
    ['https://v3b.fal.media/files/b/x/model.glb', 'model3d'],
    ['https://v3b.fal.media/files/b/x/hy_motion_000.fbx', 'motion'],
    ['https://v3b.fal.media/files/b/x/HY_MOTION.FBX', 'motion'],
    ['https://v3b.fal.media/files/b/x/track.mp3', 'audio'],
    ['https://v3b.fal.media/files/b/x/motion.json', 'link'],
  ])('%s → %s', (url, kind) => {
    expect(classifyOutput(url)).toBe(kind);
  });
});
