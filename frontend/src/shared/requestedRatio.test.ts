import { describe, expect, it } from 'vitest';
import { requestedRatio } from './schema';

/**
 * The rule this encodes: a ratio in the request is an instruction, and a
 * layout frame's shape is not. The agents used to push a frame-derived ratio
 * into the request without asking whether the request had already said
 * something, so a storyboard frame drawn 2500x1400 (which snaps to 16:9
 * within tolerance) silently overrode settings cards asking for 9:16, and
 * every video came back landscape.
 */
describe('requestedRatio', () => {
  it('reads an explicit W:H aspect ratio', () => {
    expect(requestedRatio({ aspect_ratio: '9:16' })).toBe('9:16');
    expect(requestedRatio({ aspect_ratio: '16:9' })).toBe('16:9');
    expect(requestedRatio({ aspect_ratio: '21:9' })).toBe('21:9');
    expect(requestedRatio({ aspect_ratio: ' 1:1 ' })).toBe('1:1');
  });

  it('treats a hand-back-to-the-model value as no request at all', () => {
    // MiniMax H3's default. It means "take the frame from the references",
    // which is exactly when a frame's shape may legitimately decide.
    expect(requestedRatio({ aspect_ratio: 'adaptive' })).toBeNull();
    expect(requestedRatio({ aspect_ratio: 'auto' })).toBeNull();
    expect(requestedRatio({})).toBeNull();
    expect(requestedRatio({ aspect_ratio: '' })).toBeNull();
  });

  it('reads fal named size buckets too', () => {
    expect(requestedRatio({ image_size: 'portrait_16_9' })).toBe('9:16');
    expect(requestedRatio({ image_size: 'landscape_16_9' })).toBe('16:9');
    expect(requestedRatio({ image_size: 'square_hd' })).toBe('1:1');
  });

  it('prefers the explicit ratio field over a size bucket', () => {
    expect(requestedRatio({ aspect_ratio: '9:16', image_size: 'landscape_16_9' })).toBe('9:16');
  });

  it('ignores values it cannot read as a ratio', () => {
    for (const input of [
      { aspect_ratio: 9 },
      { aspect_ratio: null },
      { aspect_ratio: 'widescreen' },
      { aspect_ratio: '16-9' },
      { image_size: 'enormous' },
      { image_size: { width: 1080, height: 1920 } },
    ])
      expect(requestedRatio(input as Record<string, unknown>), JSON.stringify(input)).toBeNull();
  });
});
