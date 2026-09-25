// Same-origin frame messaging.
//
// The panel, modal and headless iframes are siblings inside the Miro board
// page, alongside every OTHER installed app's iframe. They talk with
// postMessage, and the only thing that keeps a prompt or an output URL from
// landing in a stranger's iframe is the targetOrigin argument: a message
// posted with `'*'` is delivered to whatever origin the frame happens to be,
// while one posted with our own origin is silently dropped by the browser for
// any frame that is not ours. Nothing here may ever post with `'*'`.
//
// Receiving is guarded the same way: `isOurs(event)` is the single check every
// listener must apply before trusting event.data.

export type FrameLike = { postMessage: (message: unknown, targetOrigin: string) => void };

/** Our own origin — the only one we send to or accept from. */
export function ownOrigin(): string {
  return window.location.origin;
}

/**
 * Deliver `message` to every same-origin sibling frame (and to ourselves,
 * which is harmless — listeners ignore what isn't addressed to them).
 *
 * `frames` and `origin` are injectable for tests; production callers pass
 * nothing and get the real sibling list.
 */
export function postToSiblings(
  message: unknown,
  opts: { frames?: Iterable<FrameLike>; origin?: string } = {},
): void {
  const origin = opts.origin ?? ownOrigin();
  const frames = opts.frames ?? siblingFrames();
  for (const frame of frames) {
    try {
      frame.postMessage(message, origin);
    } catch {
      // A frame that is mid-navigation or already detached — nothing to do.
    }
  }
}

/** True when the event came from a frame on our own origin. */
export function isOurs(event: { origin: string }): boolean {
  return event.origin === ownOrigin();
}

function siblingFrames(): FrameLike[] {
  const out: FrameLike[] = [];
  try {
    const parent = window.parent;
    if (!parent || parent === window) return out;
    for (let i = 0; i < parent.frames.length; i++) out.push(parent.frames[i]);
  } catch {
    // Cross-origin parent that refuses to enumerate — nothing to deliver to.
  }
  return out;
}

/**
 * Deliver `message` to every frame on the board page, at our own origin only.
 *
 * postToSiblings reaches the app's own iframes, which sit directly under the
 * board page. Embed widgets are nested deeper, so a nudge meant for an embed
 * node has to walk the whole tree — `length` and indexed access are on the
 * cross-origin allowlist, so the walk works from here. The browser drops the
 * message for any frame that isn't on our origin, so nothing leaks to other
 * apps' frames; the node page ignores anything it didn't expect.
 */
export function postToAllFrames(message: unknown): void {
  const targets: Window[] = [];
  const collect = (win: Window, depth: number): void => {
    if (depth > 8 || targets.length > 200) return;
    targets.push(win);
    let n = 0;
    try {
      n = win.length;
    } catch {
      return;
    }
    for (let i = 0; i < n; i++) {
      try {
        collect(win[i] as Window, depth + 1);
      } catch {
        /* a frame we cannot index into */
      }
    }
  };
  try {
    collect(window.top ?? window.parent, 0);
  } catch {
    return;
  }
  const origin = ownOrigin();
  for (const win of targets) {
    try {
      win.postMessage(message, origin);
    } catch {
      /* detached or mid-navigation */
    }
  }
}
