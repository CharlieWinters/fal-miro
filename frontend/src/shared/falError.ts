// Turning a Fal failure into one line a human can act on.
//
// This is the frontend twin of backend/src/lib/errors.ts, and a deliberate
// duplicate of it — the same way shared/falOutput.ts twins
// backend/src/lib/output.ts. The two connection modes fail differently and
// neither can see the other's code:
//
//   backend mode — the backend already ran falError() over Fal's response, so
//     the thrown Error's message is the flattened text and there is nothing
//     left to unpack.
//   client mode  — @fal-ai/client throws Fal's own error object with the raw
//     `body.detail` array still on it, so the flattening has to happen here.
//
// Anything that renders a failure should call this rather than reading
// `err.message`, so both modes read the same.

type FalErrorDetail = { loc?: unknown; msg?: string; type?: string } | string;

/** Fal's 422 body: `{ detail: [{ loc, msg, type }, …] }`. */
function detailOf(err: unknown): unknown {
  return (err as { body?: { detail?: unknown } } | undefined)?.body?.detail;
}

/**
 * The most useful single line describing a Fal failure.
 *
 * Kept to one line on purpose: it renders inside a placeholder image on the
 * board, where the wrapping is done by the caller and the space is small.
 */
export function describeFalError(err: unknown): string {
  const detail = detailOf(err);
  if (detail) {
    try {
      const details: FalErrorDetail[] = Array.isArray(detail) ? detail : [detail];
      const first = details[0];
      // Fal's least helpful error, and by far the most common one to get
      // twice. Same wording the backend uses.
      if (typeof first === 'object' && first?.type === 'no_media_generated') {
        return (
          'Fal produced no output (no_media_generated). Common causes: the inputs ' +
          "can't be turned into the requested media — e.g. first/last frames that are " +
          'too different to transition between — or content blocked by safety. Try ' +
          'frames from the same scene/subject.'
        );
      }
      const msgs = details.map((d) => {
        if (typeof d === 'string') return d;
        const loc = Array.isArray(d.loc) ? d.loc.filter((p) => p !== 'body').join('.') : d.loc;
        return [loc, d.msg].filter(Boolean).join(': ');
      });
      const joined = msgs.filter(Boolean).join(' | ');
      if (joined) return joined;
    } catch {
      /* fall through to the plain message */
    }
  }
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string' && err) return err;
  // Last resort. JSON.stringify returns undefined (not a string) for
  // undefined, and "{}" for an object with nothing enumerable — neither is
  // worth putting on a card, so anything that uninformative becomes a plain
  // "Unknown error" instead.
  try {
    const json = JSON.stringify(err);
    if (json && json !== '{}' && json !== 'null') return json;
  } catch {
    /* not serialisable */
  }
  return 'Unknown error';
}

// Codes that are about OUR call rather than the job. A rejected or throttled
// key says nothing about whether the generation would have worked, so these
// stay transient even when a detail body is present.
const CALLER_FAULT_STATUSES = new Set([401, 403, 408, 429]);

/**
 * Map a Fal status/result HTTP error to a terminal job status, or null if it is
 * transient (network, rate limit, an unexplained 5xx) and worth retrying.
 *
 * The twin of `terminalStatusFor` in the backend's `app.ts`, and a deliberate
 * duplicate of it for the same reason `describeFalError` duplicates
 * `falError`: in backend mode the route has already done this mapping and the
 * frontend sees a clean `FAILED` status, but in client mode there is no route —
 * `@fal-ai/client` throws Fal's error straight into the browser, and nothing
 * was translating it.
 *
 * Getting this wrong is expensive in a specific way. `pollStatus` treats a
 * thrown error as a transport problem: it retries five times with backoff and
 * then reports `PollUnreachable`, which callers deliberately leave alone so
 * `resume_jobs` can collect the result later. For a request Fal has
 * permanently rejected there is no result to collect, so the placeholder sits
 * on the board saying "generating" and the panel says "resuming" until the
 * failure budget runs out — with the actual reason, which Fal sent in full on
 * the very first poll, never shown.
 *
 * `hasModelDetail` says whether the error carried a model-level `detail` body.
 * That is the signal that Fal *reached* the model and the model refused the
 * job, which is terminal whatever status code it arrives under — Bria's
 * ad-delayer refuses an oversized image with a 500.
 */
export function terminalStatusFor(
  httpStatus: unknown,
  hasModelDetail = false,
): 'FAILED' | 'UNKNOWN' | null {
  if (httpStatus === 404) return 'UNKNOWN';
  if (httpStatus === 400 || httpStatus === 422) return 'FAILED';
  if (typeof httpStatus !== 'number' || CALLER_FAULT_STATUSES.has(httpStatus)) return null;
  return hasModelDetail && httpStatus >= 400 ? 'FAILED' : null;
}

/** Does this error carry a model-level `detail` body? */
export function hasModelDetail(err: unknown): boolean {
  return Boolean((err as { body?: { detail?: unknown } } | undefined)?.body?.detail);
}

/** The HTTP status a Fal client error arrived under, if it exposes one. */
export function httpStatusOf(err: unknown): number | undefined {
  const s = (err as { status?: unknown } | undefined)?.status;
  return typeof s === 'number' ? s : undefined;
}
