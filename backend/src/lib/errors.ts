export function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

type FalErrorDetail = { loc?: unknown; msg?: string; type?: string } | string;

// Fal validation errors (422) put the useful info in err.body.detail — a list
// of { loc, msg, type }. Surface that instead of the generic "Unprocessable
// Entity" so the frontend (and logs) show what was actually rejected.
export function falError(err: unknown): string {
  const body = (err as { body?: { detail?: unknown } } | undefined)?.body;
  if (body?.detail) {
    try {
      const details: FalErrorDetail[] = Array.isArray(body.detail) ? body.detail : [body.detail];
      const first = details[0];
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
      /* fall through */
    }
  }
  return messageOf(err);
}
