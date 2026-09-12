// The point of describeFalError is that a failure reads the same whichever
// connection mode produced it, so the cases that matter are the two shapes:
// backend mode hands over an Error whose message the backend already
// flattened, client mode hands over Fal's raw object with body.detail intact.

import { describe, it, expect } from 'vitest';
import { describeFalError } from './falError';

/** The real 422 body Fal returns for an undersized video reference. */
const tooSmall = {
  body: {
    detail: [
      {
        loc: ['body', 'video_urls', 0],
        msg: 'Video dimensions are too small. Minimum dimensions are 300x300 pixels. Found 320x240 pixels.',
        type: 'video_too_small',
      },
    ],
  },
};

describe('describeFalError', () => {
  it('flattens a client-mode validation error into loc: msg', () => {
    expect(describeFalError(tooSmall)).toBe(
      'video_urls.0: Video dimensions are too small. Minimum dimensions are 300x300 pixels. Found 320x240 pixels.',
    );
  });

  it('drops the leading "body" from the location path', () => {
    expect(describeFalError(tooSmall)).not.toContain('body');
  });

  it('joins several details rather than showing only the first', () => {
    const err = {
      body: {
        detail: [
          { loc: ['body', 'prompt'], msg: 'field required', type: 'missing' },
          { loc: ['body', 'duration'], msg: 'must be <= 10', type: 'too_large' },
        ],
      },
    };
    expect(describeFalError(err)).toBe('prompt: field required | duration: must be <= 10');
  });

  it('expands no_media_generated, which says nothing useful on its own', () => {
    const err = { body: { detail: [{ type: 'no_media_generated', msg: '' }] } };
    const out = describeFalError(err);
    expect(out).toContain('no_media_generated');
    expect(out).toContain('safety');
  });

  it('accepts a detail that is a bare string', () => {
    expect(describeFalError({ body: { detail: 'Model is overloaded' } })).toBe('Model is overloaded');
  });

  it('accepts a detail object that is not wrapped in an array', () => {
    const err = { body: { detail: { loc: ['body', 'image_urls'], msg: 'too many items' } } };
    expect(describeFalError(err)).toBe('image_urls: too many items');
  });

  it('passes a backend-mode Error message straight through', () => {
    // The backend already ran its own falError() over this.
    const msg = 'video_urls.0: Video dimensions are too small.';
    expect(describeFalError(new Error(msg))).toBe(msg);
  });

  it('falls back to the message when detail is present but empty', () => {
    const err = Object.assign(new Error('502 Bad Gateway'), { body: { detail: [] } });
    expect(describeFalError(err)).toBe('502 Bad Gateway');
  });

  it('handles a plain string', () => {
    expect(describeFalError('boom')).toBe('boom');
  });

  it('always returns a string, even for junk it cannot describe', () => {
    // JSON.stringify(undefined) is undefined, not a string — the returned
    // value goes straight onto a board card, so this has to hold.
    expect(describeFalError(undefined)).toBe('Unknown error');
    expect(describeFalError(null)).toBe('Unknown error');
    expect(describeFalError({})).toBe('Unknown error');
    expect(typeof describeFalError(42)).toBe('string');
  });
});
