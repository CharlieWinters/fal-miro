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
