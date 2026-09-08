// This app takes a URL typed by a person and puts it in an iframe `src` and in
// a `video_url` sent to Fal, so the interesting cases are the hostile and the
// nearly-right ones: a `javascript:` scheme, our own player URL pasted back in,
// an archive.org page URL that isn't a video at all, and an item whose
// preservation master is 30x the size of the derivative you actually want.

import { describe, it, expect } from 'vitest';
import {
  archiveMetadataUrl,
  containerWarning,
  embedBox,
  formatBytes,
  formatDuration,
  parseVideoInput,
  pickArchiveVideo,
  type ArchiveMetadata,
} from './videoUrl';

describe('parseVideoInput', () => {
  it('accepts a plain https video URL', () => {
    const r = parseVideoInput('https://v3.fal.media/files/penguin/abc.mp4');
    expect(r).toEqual({ kind: 'direct', url: 'https://v3.fal.media/files/penguin/abc.mp4' });
  });

  it('trims surrounding whitespace', () => {
    const r = parseVideoInput('  https://example.com/a.mp4\n');
    expect(r).toEqual({ kind: 'direct', url: 'https://example.com/a.mp4' });
  });

  it('rejects empty input', () => {
    expect(parseVideoInput('   ')).toMatchObject({ kind: 'error' });
  });

  it('rejects text that is not a URL', () => {
    expect(parseVideoInput('my holiday video')).toMatchObject({ kind: 'error' });
  });

  it('rejects a javascript: scheme', () => {
    const r = parseVideoInput('javascript:alert(1)');
    expect(r.kind).toBe('error');
    // It parses as a URL, so only the protocol check stops it.
    expect(r.kind === 'error' && r.message).toContain('javascript:');
  });

  it('rejects a data: URL', () => {
    expect(parseVideoInput('data:video/mp4;base64,AAAA')).toMatchObject({ kind: 'error' });
  });

  it('rejects a file: URL', () => {
    expect(parseVideoInput('file:///Users/me/clip.mp4')).toMatchObject({ kind: 'error' });
  });

  it('unwraps one of our own player URLs instead of double-wrapping it', () => {
    const inner = 'https://example.com/clip.mp4';
    const player = `https://host.example/fal-miro/embed-video.html?url=${encodeURIComponent(inner)}`;
    expect(parseVideoInput(player)).toEqual({ kind: 'direct', url: inner });
  });

  it('unwraps a player URL served from the dev server root', () => {
    const inner = 'https://example.com/clip.mp4';
    const player = `http://localhost:5175/embed-video.html?url=${encodeURIComponent(inner)}`;
    expect(parseVideoInput(player)).toEqual({ kind: 'direct', url: inner });
  });

  it('errors on a player URL with no video in it', () => {
    expect(parseVideoInput('https://host.example/embed-video.html')).toMatchObject({ kind: 'error' });
  });

  it('stops unwrapping rather than following an absurdly nested player URL', () => {
    let url = 'https://example.com/clip.mp4';
    for (let i = 0; i < 5; i += 1) {
      url = `https://host.example/embed-video.html?url=${encodeURIComponent(url)}`;
    }
    expect(parseVideoInput(url)).toMatchObject({ kind: 'error' });
  });

  it('recognises an archive.org details page as an item to resolve', () => {
    const r = parseVideoInput('https://archive.org/details/201932_Computer-Made_Movies');
    expect(r).toEqual({ kind: 'archive-item', identifier: '201932_Computer-Made_Movies' });
  });

  it('takes the identifier from a details URL with extra path segments', () => {
    const r = parseVideoInput('https://archive.org/details/some_item/page/n1/mode/2up');
    expect(r).toEqual({ kind: 'archive-item', identifier: 'some_item' });
  });

  it('treats an archive.org download URL as directly playable', () => {
    const url = 'https://archive.org/download/some_item/some_item.mp4';
    expect(parseVideoInput(url)).toEqual({ kind: 'direct', url });
  });

  it('errors on a details URL with no identifier', () => {
    expect(parseVideoInput('https://archive.org/details/')).toMatchObject({ kind: 'error' });
  });
});

describe('archiveMetadataUrl', () => {
  it('encodes the identifier', () => {
    expect(archiveMetadataUrl('a b')).toBe('https://archive.org/metadata/a%20b');
  });
});

describe('pickArchiveVideo', () => {
  // Shaped like the real response for 201932_Computer-Made_Movies: a 1.6 GB
  // master, a 55 MB derivative of the same film, and non-video clutter.
  const meta: ArchiveMetadata = {
    files: [
      { name: 'item.thumbs/frame_000001.jpg', format: 'Thumbnail', size: '45955' },
      { name: 'item_archive.torrent', format: 'Archive BitTorrent', size: '33727' },
      { name: 'item_master.H.264.ia.mp4', format: 'h.264 IA', size: '55352522' },
      { name: 'item_master.H.264.mp4', format: 'MPEG4', size: '1597740802' },
      { name: 'item_meta.xml', format: 'Metadata' },
    ],
  };

  it('picks the small derivative over the preservation master', () => {
    const r = pickArchiveVideo('201932_Computer-Made_Movies', meta);
    expect(r).toMatchObject({
      name: 'item_master.H.264.ia.mp4',
      bytes: 55352522,
      format: 'h.264 IA',
      url: 'https://archive.org/download/201932_Computer-Made_Movies/item_master.H.264.ia.mp4',
    });
  });

  it('ignores non-video files even when they are smaller', () => {
    const r = pickArchiveVideo('x', meta);
    expect('url' in r && r.url.endsWith('.mp4')).toBe(true);
  });

  it('errors when the item holds no playable video', () => {
    const r = pickArchiveVideo('x', { files: [{ name: 'scan.pdf', size: '10' }] });
    expect(r).toMatchObject({ error: expect.any(String) });
  });

  it('errors when the metadata has no file list at all', () => {
    expect(pickArchiveVideo('x', {})).toMatchObject({ error: expect.any(String) });
  });

  it('keeps slashes in a nested file name but encodes the segments', () => {
    const r = pickArchiveVideo('my item', { files: [{ name: 'sub dir/a b.mp4', size: '5' }] });
    expect('url' in r && r.url).toBe('https://archive.org/download/my%20item/sub%20dir/a%20b.mp4');
  });

  it('sorts a file with no size last rather than treating it as zero bytes', () => {
    const r = pickArchiveVideo('x', {
      files: [
        { name: 'unsized.mp4' },
        { name: 'sized.mp4', size: '900' },
      ],
    });
    expect('name' in r && r.name).toBe('sized.mp4');
  });
});

describe('containerWarning', () => {
  it('warns about a container browsers cannot play', () => {
    expect(containerWarning('https://example.com/a.mkv')).toContain('.mkv');
  });

  it('stays quiet for mp4', () => {
    expect(containerWarning('https://example.com/a.mp4')).toBeNull();
  });

  it('stays quiet when there is no extension at all (Fal CDN, signed URLs)', () => {
    expect(containerWarning('https://v3.fal.media/files/penguin/abc')).toBeNull();
  });

  it('does not mistake a dot in a directory for the file extension', () => {
    expect(containerWarning('https://example.com/v1.2/clip.mp4')).toBeNull();
  });

  it('ignores the query string when reading the extension', () => {
    expect(containerWarning('https://example.com/a.mp4?token=x.y')).toBeNull();
  });
});

describe('embedBox', () => {
  it('preserves a landscape shape', () => {
    expect(embedBox(1920, 1080)).toEqual({ width: 640, height: 360 });
  });

  it('preserves a portrait shape', () => {
    expect(embedBox(1080, 1920)).toEqual({ width: 640, height: 1138 });
  });

  it('falls back to 16:9 when the probe read no dimensions', () => {
    expect(embedBox(0, 0)).toEqual({ width: 640, height: 360 });
    expect(embedBox(NaN, NaN)).toEqual({ width: 640, height: 360 });
  });
});

describe('formatDuration', () => {
  it('formats seconds as m:ss', () => {
    expect(formatDuration(634.9375)).toBe('10:35');
    expect(formatDuration(8)).toBe('0:08');
  });

  it('handles a duration the browser could not read', () => {
    expect(formatDuration(NaN)).toBe('—');
    expect(formatDuration(Infinity)).toBe('—');
  });
});

describe('formatBytes', () => {
  it('formats MB and GB', () => {
    expect(formatBytes(55352522)).toBe('52.8 MB');
    expect(formatBytes(1597740802)).toBe('1.49 GB');
  });

  it('returns null when the size is unknown', () => {
    expect(formatBytes(null)).toBeNull();
    expect(formatBytes(0)).toBeNull();
  });
});

describe('pickArchiveVideo — container extensions', () => {
  it('matches the extension case-insensitively (CLIP.MP4)', () => {
    const r = pickArchiveVideo('x', { files: [{ name: 'CLIP.MP4', size: '10' }] });
    expect(r).toMatchObject({ name: 'CLIP.MP4', url: 'https://archive.org/download/x/CLIP.MP4' });
  });

  it.each(['.webm', '.ogv', '.ogg', '.m4v', '.mov', '.mp4'])('accepts a %s file', (ext) => {
    const r = pickArchiveVideo('x', { files: [{ name: `clip${ext}`, size: '10' }] });
    expect('url' in r).toBe(true);
    expect('name' in r && r.name).toBe(`clip${ext}`);
  });

  it('errors on an item whose only video is an .mkv', () => {
    const r = pickArchiveVideo('x', { files: [{ name: 'clip.mkv', format: 'Matroska', size: '10' }] });
    expect(r).toMatchObject({ error: expect.stringContaining('no browser-playable video') });
  });

  it('skips the .mkv and picks the playable sibling', () => {
    const r = pickArchiveVideo('x', {
      files: [
        { name: 'clip.mkv', size: '1' },
        { name: 'clip.webm', size: '900' },
      ],
    });
    expect('name' in r && r.name).toBe('clip.webm');
  });
});
