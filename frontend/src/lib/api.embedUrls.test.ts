// Embed URL round-trips.
//
// Every embed we create carries a cache-buster, because Miro resolves an embed
// URL once and caches the outcome — including a failure — against that exact
// URL. See the comment on embedPageUrl in api.ts for the incident.
//
// That makes the builder/unwrapper pair a contract worth pinning: the builder
// must keep producing a URL the unwrapper can read, no matter what else it puts
// in the query string, and it must never hand back the same URL twice.

import { describe, it, expect } from 'vitest';
import {
  videoEmbedUrl,
  model3dEmbedUrl,
  audioEmbedUrl,
  panoramaEmbedUrl,
  rigEmbedUrl,
  unwrapVideoEmbedUrl,
  unwrapModel3dEmbedUrl,
  unwrapAudioEmbedUrl,
  unwrapPanoramaEmbedUrl,
  unwrapRigEmbedUrl,
} from './api';

const PAIRS = [
  ['video', videoEmbedUrl, unwrapVideoEmbedUrl, 'https://v3b.fal.media/files/b/x/clip.mp4'],
  ['3d', model3dEmbedUrl, unwrapModel3dEmbedUrl, 'https://v3b.fal.media/files/b/x/model.glb'],
  ['audio', audioEmbedUrl, unwrapAudioEmbedUrl, 'https://v3b.fal.media/files/b/x/track.mp3'],
  ['panorama', panoramaEmbedUrl, unwrapPanoramaEmbedUrl, 'https://v3b.fal.media/files/b/x/pano.jpg'],
  ['rig', rigEmbedUrl, unwrapRigEmbedUrl, 'https://v3b.fal.media/files/b/x/running.glb'],
] as const;

describe.each(PAIRS)('%s embed URL', (_kind, build, unwrap, asset) => {
  it('round-trips the asset URL', () => {
    expect(unwrap(build(asset))).toBe(asset);
  });

  it('carries a cache-buster', () => {
    const cb = new URL(build(asset), 'https://example.test').searchParams.get('cb');
    expect(cb).toBeTruthy();
  });

  it('never returns the same URL twice', () => {
    // A repeat URL is the bug: Miro would serve its cached resolution, and if
    // that resolution was a failure the embed stays a dead placeholder.
    const seen = new Set(Array.from({ length: 50 }, () => build(asset)));
    expect(seen.size).toBe(50);
  });

  it('survives an asset URL that already has query parameters', () => {
    const tricky = `${asset}?token=abc&expires=123`;
    expect(unwrap(build(tricky))).toBe(tricky);
  });

  it('survives an asset URL containing an encoded ampersand', () => {
    const nasty = `${asset}?a=1%26b=2`;
    expect(unwrap(build(nasty))).toBe(nasty);
  });

  it('rejects an embed URL for a different viewer page', () => {
    const other = PAIRS.find(([k]) => k !== _kind)!;
    expect(unwrap(other[1](other[3]))).toBeNull();
  });

  it('returns null on junk rather than throwing', () => {
    expect(unwrap('not a url at all')).toBeNull();
    expect(unwrap('')).toBeNull();
  });
});

describe('cache-buster placement', () => {
  it('does not disturb the url parameter regardless of order', () => {
    // The unwrappers read via searchParams, so param order must not matter.
    const asset = 'https://v3b.fal.media/files/b/x/model.glb';
    const built = model3dEmbedUrl(asset);
    const u = new URL(built, 'https://example.test');
    const reordered = `${u.origin}${u.pathname}?cb=${u.searchParams.get('cb')}&url=${encodeURIComponent(asset)}`;
    expect(unwrapModel3dEmbedUrl(reordered)).toBe(asset);
  });
});
