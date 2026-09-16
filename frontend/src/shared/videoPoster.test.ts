// What a video embed shows before you click it.
//
// Verified live on a board: created with no `previewUrl`, an embed comes back
// carrying `https://mirostatic.com/partners-embed/preview-images/…` — Miro's
// own generic placeholder. That is the grey card a finished video has always
// shown. Given an http(s) `previewUrl` Miro keeps it verbatim; given a `data:`
// URI it tries to rehost it and the upload 400s. So the only job here is to
// produce one http URL, and to never fail loudly doing it: the video is
// already generated and paid for by the time this runs.

import { describe, it, expect } from 'vitest';
import { resolveVideoPoster, type PosterDeps } from './videoPoster';

const VIDEO = 'https://v3b.fal.media/files/b/0aaa2515/clip.mp4';
const FRAME = 'https://v3.fal.media/files/elephant/IHmmk4dvyoCCYhtzI2FsO_frame.jpg';

/** A seam that records whether the extract endpoint was called at all. */
function seam(
  final: { status: string; output?: string[]; data?: Record<string, unknown> },
): PosterDeps & { calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    run: async (body) => {
      calls.push(body.input);
      return { requestId: 'req-1' };
    },
    poll: async () => final,
  };
}

describe('resolveVideoPoster', () => {
  it('uses a public reference URL and spends nothing', async () => {
    // An image *created from* a URL keeps that URL, so this case is free.
    const s = seam({ status: 'SUCCEEDED', output: [FRAME] });
    const out = await resolveVideoPoster(VIDEO, 'https://v3b.fal.media/files/b/x/key.jpg', s);
    expect(out).toBe('https://v3b.fal.media/files/b/x/key.jpg');
    expect(s.calls).toHaveLength(0);
  });

  it('ignores a data-URI reference and extracts the frame instead', async () => {
    // getImageUrl hands back a data URI for board images, and Miro rejects
    // those as a preview — so it is not a candidate however convenient.
    const s = seam({ status: 'SUCCEEDED', output: [FRAME] });
    const out = await resolveVideoPoster(VIDEO, 'data:image/png;base64,AAAA', s);
    expect(out).toBe(FRAME);
    expect(s.calls[0]).toEqual({ video_url: VIDEO, frame_type: 'first' });
  });

  it('extracts the frame when the reference reports no url at all', async () => {
    // An image *uploaded* to Miro reports an empty url — observed live.
    const s = seam({ status: 'SUCCEEDED', output: [FRAME] });
    expect(await resolveVideoPoster(VIDEO, '', s)).toBe(FRAME);
  });

  it('reads the frame out of the raw payload when output is empty', async () => {
    const s = seam({ status: 'SUCCEEDED', data: { images: [{ url: FRAME }] } });
    expect(await resolveVideoPoster(VIDEO, null, s)).toBe(FRAME);
  });

  it('gives up quietly when the extract fails', async () => {
    const s = seam({ status: 'FAILED' });
    expect(await resolveVideoPoster(VIDEO, null, s)).toBeUndefined();
  });

  it('gives up quietly when the extract returns no image', async () => {
    const s = seam({ status: 'SUCCEEDED', output: [] });
    expect(await resolveVideoPoster(VIDEO, null, s)).toBeUndefined();
  });

  it('never propagates a throw — a missing thumbnail must not lose the video', async () => {
    const out = await resolveVideoPoster(VIDEO, null, {
      run: async () => {
        throw new Error('queue is down');
      },
    });
    expect(out).toBeUndefined();
  });

  it('does not call the extract endpoint for a video Fal could not fetch', async () => {
    // A blob: or data: video has nothing for a server-side ffmpeg to read.
    const s = seam({ status: 'SUCCEEDED', output: [FRAME] });
    expect(await resolveVideoPoster('blob:http://localhost/abc', null, s)).toBeUndefined();
    expect(s.calls).toHaveLength(0);
  });

  it('refuses a data-URI frame even if the endpoint returned one', async () => {
    // Miro 400s on a data-URI preview, so passing one through would just
    // reinstate the grey placeholder with extra steps.
    const s = seam({ status: 'SUCCEEDED', output: ['data:image/jpeg;base64,AAAA'] });
    expect(await resolveVideoPoster(VIDEO, null, s)).toBeUndefined();
  });
});
