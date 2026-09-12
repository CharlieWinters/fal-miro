// The point of describeFalError is that a failure reads the same whichever
// connection mode produced it, so the cases that matter are the two shapes:
// backend mode hands over an Error whose message the backend already
// flattened, client mode hands over Fal's raw object with body.detail intact.

import { describe, it, expect } from 'vitest';
import { describeFalError, terminalStatusFor, hasModelDetail, httpStatusOf } from './falError';

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

// ─────────────────────────────────────────────────────────────────────────────
// Terminal vs transient.
//
// The live failure: H3 Max rejected a reference image for being under 256x256.
// Fal said so precisely, on the first status poll, with a 422 and a detail
// body. In client mode nothing translated that, so `pollStatus` counted it as
// a transport error, retried five times with backoff, and threw
// PollUnreachable — which every caller deliberately leaves alone for
// resume_jobs. The board kept a placeholder reading "generating", the panel
// kept saying "resuming", and the reason was never shown anywhere.
// ─────────────────────────────────────────────────────────────────────────────

describe('terminalStatusFor', () => {
  it('treats a validation rejection as a finished, failed job', () => {
    expect(terminalStatusFor(422)).toBe('FAILED');
    expect(terminalStatusFor(400)).toBe('FAILED');
  });

  it('treats a request Fal has never heard of as unknown', () => {
    expect(terminalStatusFor(404)).toBe('UNKNOWN');
  });

  it('keeps our own fault transient, even with a detail body', () => {
    // A rejected or throttled key says nothing about whether the generation
    // would have worked, so these are worth retrying.
    for (const code of [401, 403, 408, 429]) {
      expect(terminalStatusFor(code, true)).toBeNull();
    }
  });

  it('keeps an unexplained 5xx transient', () => {
    expect(terminalStatusFor(500)).toBeNull();
    expect(terminalStatusFor(503)).toBeNull();
  });

  it('trusts a model-level detail body over the status code', () => {
    // Bria's ad-delayer refuses an oversized image with a 500. Reading that as
    // transient had the caller retrying a hopeless job on every board load.
    expect(terminalStatusFor(500, true)).toBe('FAILED');
  });

  it('stays transient when there is no status code at all', () => {
    // A genuine network failure — no response, nothing to classify.
    expect(terminalStatusFor(undefined)).toBeNull();
    expect(terminalStatusFor('nope')).toBeNull();
  });
});

describe('reading a Fal client error', () => {
  const falError = Object.assign(new Error('Unprocessable Entity'), {
    status: 422,
    body: {
      detail: [
        {
          loc: ['body', 'reference_image_urls', 0],
          msg: 'Image dimensions are too small. Minimum dimensions are 256x256 pixels.',
          type: 'value_error',
        },
      ],
    },
  });

  it('finds the status and the detail body', () => {
    expect(httpStatusOf(falError)).toBe(422);
    expect(hasModelDetail(falError)).toBe(true);
  });

  it('maps it to FAILED and keeps the actionable line', () => {
    expect(terminalStatusFor(httpStatusOf(falError), hasModelDetail(falError))).toBe('FAILED');
    expect(describeFalError(falError)).toBe(
      'reference_image_urls.0: Image dimensions are too small. Minimum dimensions are 256x256 pixels.',
    );
  });

  it('reports nothing useful for a bare network error, and stays transient', () => {
    const offline = new Error('Failed to fetch');
    expect(httpStatusOf(offline)).toBeUndefined();
    expect(hasModelDetail(offline)).toBe(false);
    expect(terminalStatusFor(httpStatusOf(offline), hasModelDetail(offline))).toBeNull();
  });
});
