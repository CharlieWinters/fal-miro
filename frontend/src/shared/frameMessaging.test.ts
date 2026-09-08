import { describe, expect, it, vi } from 'vitest';
import { isOurs, postToSiblings } from './frameMessaging';

describe('postToSiblings', () => {
  it('posts to every frame with our origin, never with a wildcard', () => {
    const a = { postMessage: vi.fn() };
    const b = { postMessage: vi.fn() };
    postToSiblings({ type: 'RUN_AGENT' }, { frames: [a, b], origin: 'https://app.example' });
    expect(a.postMessage).toHaveBeenCalledWith({ type: 'RUN_AGENT' }, 'https://app.example');
    expect(b.postMessage).toHaveBeenCalledWith({ type: 'RUN_AGENT' }, 'https://app.example');
    for (const call of [...a.postMessage.mock.calls, ...b.postMessage.mock.calls]) {
      expect(call[1]).not.toBe('*');
    }
  });

  it('defaults the target origin to this window', () => {
    const a = { postMessage: vi.fn() };
    postToSiblings('hello', { frames: [a] });
    expect(a.postMessage).toHaveBeenCalledWith('hello', window.location.origin);
  });

  it('keeps going when one frame throws', () => {
    const bad = {
      postMessage: vi.fn(() => {
        throw new Error('detached');
      }),
    };
    const good = { postMessage: vi.fn() };
    expect(() => postToSiblings('x', { frames: [bad, good], origin: 'o' })).not.toThrow();
    expect(good.postMessage).toHaveBeenCalledTimes(1);
  });
});

describe('isOurs', () => {
  it('accepts our own origin only', () => {
    expect(isOurs({ origin: window.location.origin })).toBe(true);
    expect(isOurs({ origin: 'https://evil.example' })).toBe(false);
    expect(isOurs({ origin: '' })).toBe(false);
    expect(isOurs({ origin: 'null' })).toBe(false);
  });
});
