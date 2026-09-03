// Prompt source control — the explicit replacement for the old always-on
// sticky autofill (see hooks/boardInputs.ts's usePromptSource).
//
// Three modes plus a one-shot verb, per the Claude Design spec:
//   • the modes are a segmented control — a cycling button can't say what it
//     is doing now without also implying what it will do next, and this
//     control decides whether the user's typing survives;
//   • the verb ("pull once") sits on the label row, outside the mode box, as
//     a pill with an icon that never latches — so it can't read as a fourth
//     mode;
//   • a driven field is visibly read-only: it loses its own border and
//     becomes the body of a cyan-edged frame with a live header and an
//     "Unlink to edit" escape.
//
// Deliberately distinct from the nav `.seg` (a filled track holding raised
// pills): this is an outlined container with a flat active fill and dividers,
// under an uppercase field label nav never has. Same family, clearly a
// setting. Cyan (--info) means "the board is driving this" throughout; yellow
// stays reserved for Generate.

import type { PromptNote } from './hooks/boardInputs';
import type { PromptSource } from '../shared/storage';

const MODES: Array<{ value: PromptSource; label: string }> = [
  { value: 'off', label: 'Off' },
  { value: 'selection', label: 'Selection' },
  { value: 'connected', label: 'Connected' },
];

function PullIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3v11" />
      <path d="M7.5 10.5 12 15l4.5-4.5" />
      <path d="M4 19h16" />
    </svg>
  );
}

function InfoIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8.5v.01" />
      <path d="M12 12v4" />
    </svg>
  );
}

/** The label row: "Prompt source" + the mode switch + the one-shot pull. */
export function PromptSourceControl({
  mode,
  onModeChange,
  onPullOnce,
  canPull,
}: {
  mode: PromptSource;
  onModeChange: (m: PromptSource) => void;
  onPullOnce: () => void;
  /** False when nothing on the board is selected — the verb has nothing to do. */
  canPull: boolean;
}) {
  return (
    <div className="ps">
      <div className="ps-head">
        <span className="ps-title">Prompt source</span>
        <button
          type="button"
          className="ps-pull"
          onClick={onPullOnce}
          disabled={!canPull}
          title={
            canPull
              ? 'Pull once — copy the current selection in, then leave the box alone'
              : 'Select sticky notes on the board to pull them in'
          }
          aria-label="Pull the current selection in once"
        >
          <PullIcon />
        </button>
      </div>

      <div className="ps-seg" role="radiogroup" aria-label="Prompt source">
        {MODES.map((m) => (
          <button
            key={m.value}
            type="button"
            role="radio"
            aria-checked={mode === m.value}
            className={mode === m.value ? 'active' : ''}
            onClick={() => onModeChange(m.value)}
          >
            {mode === m.value && m.value !== 'off' && <span className="ps-dot-sm" />}
            {m.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * The prompt field while a live mode is actually supplying text — read-only,
 * framed, with the escape hatch. `onUnlink` keeps the current text and flips
 * to Off, handing the user a normal editable box.
 *
 * Only rendered when there IS text. A live mode with nothing to give shows
 * `PromptWaitingHint` instead and leaves the ordinary editable field in place
 * — see the note on that component for why.
 */
export function DrivenPromptField({
  mode,
  text,
  notes,
  onUnlink,
}: {
  mode: Exclude<PromptSource, 'off'>;
  text: string;
  notes: PromptNote[];
  onUnlink: () => void;
}) {
  const followNote =
    mode === 'selection'
      ? 'Updates as you change the selection on the board.'
      : "Fixed to the source image's connectors — clicking elsewhere won't change it.";

  return (
    <div className="field">
      <span>Prompt</span>

      <div className="ps-frame">
        <div className="ps-strip">
          <span className="ps-dot" />
          <span className="ps-live">
            Live · following {mode === 'selection' ? 'selection' : 'connected stickies'}
          </span>
          <button type="button" className="ps-unlink" onClick={onUnlink}>
            Unlink to edit
          </button>
        </div>
        <textarea rows={4} readOnly value={text} />
      </div>

      {notes.length > 0 && (
        <div className="ps-chips">
          {notes.map((n, i) => (
            <span className="ps-chip" key={n.id}>
              <span className="ps-chip-n">{i + 1}</span>
              <span className="ps-chip-label">{n.label}</span>
            </span>
          ))}
        </div>
      )}

      <span className="ps-note">{followNote}</span>
    </div>
  );
}

/**
 * A live mode that currently has nothing to supply.
 *
 * Shown ABOVE the ordinary editable prompt field rather than replacing it.
 * The first cut replaced the field in every live mode, which trapped the
 * user: Miro has a single selection, so on an image-primary model you must
 * select the image — which means no stickies are selected — which left the
 * prompt permanently empty AND read-only, with Generate refusing and no way
 * to type. Armed and waiting must never mean blocked.
 */
export function PromptWaitingHint({ mode }: { mode: Exclude<PromptSource, 'off'> }) {
  return (
    <div className="ps-waiting">
      <span className="ps-dot hollow" />
      <span className="ps-live">
        {mode === 'selection' ? 'Live · waiting for a selection' : 'Live · waiting for a connection'}
      </span>
      <div className="ps-empty">
        <InfoIcon />
        <span>
          {mode === 'selection'
            ? 'No sticky notes selected, so the box below is yours to type in. Pick sticky notes on the board to take it over — shift-click to keep the source image selected too.'
            : 'No sticky notes wired to the source image, so the box below is yours to type in. Draw a connector from a sticky to it to take it over.'}
        </span>
      </div>
    </div>
  );
}
