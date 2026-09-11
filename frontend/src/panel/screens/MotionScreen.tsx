import { useMemo, useState } from 'react';
import { startAgentJob } from '../communication';
import { useFirstSelected } from '../hooks/useSelection';
import { stripHtml } from '../../shared/boardHelpers';
import type { FalModel } from '../../shared/falCatalog';

type Sticky = { id: string; content?: string };

const MIN_SECONDS = 0.5;
const MAX_SECONDS = 12;

/**
 * Text → Motion (Hunyuan Motion). A prompt and a duration are the whole input;
 * the result is an animated mannequin embed placed below the selected sticky
 * (or the selected image, or wherever there is room).
 */
export function MotionScreen({ model }: { model: FalModel }) {
  const sticky = useFirstSelected<Sticky>('sticky_note');
  const anchor = useFirstSelected<{ id: string }>('image');
  const [typed, setTyped] = useState('');
  const [seconds, setSeconds] = useState(4);
  const [note, setNote] = useState<string | null>(null);

  const stickyText = useMemo(() => (sticky?.content ? stripHtml(sticky.content).trim() : ''), [sticky]);
  const prompt = typed.trim() || stickyText;

  /** Why Generate can't run yet, or null — drives the disabled button. */
  const blockReason: string | null = !prompt
    ? 'Describe the motion, or select a sticky note that does.'
    : null;

  const onGenerate = () => {
    setNote(null);
    if (blockReason) {
      setNote(blockReason);
      return;
    }
    startAgentJob({
      agentId: 'fal_motion',
      label: `${model.label} · motion`,
      kind: 'motion',
      payload: {
        endpointId: model.endpointId,
        input: { prompt, duration: seconds },
        stickyId: !typed.trim() && sticky ? sticky.id : undefined,
        anchorItemId: anchor?.id ?? sticky?.id,
      },
    });
    setNote('Generating motion — an animated figure will drop on the board when it’s ready.');
  };

  return (
    <div className="screen">
      <div className="hero">
        <div className="title">{model.label}</div>
        <div className="sub">{model.endpointId}</div>
      </div>

      <label className="field">
        <span>Motion prompt</span>
        <textarea
          rows={3}
          placeholder={stickyText ? `Using the selected sticky: “${stickyText.slice(0, 60)}”` : 'e.g. a person walks forward, stops, and waves with the right hand'}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
        />
      </label>
      <div className="hint" style={{ marginTop: -4 }}>
        {stickyText && !typed.trim()
          ? 'The selected sticky note is the prompt — type here to override it.'
          : 'One person, one action. Describe the movement, not the character.'}
      </div>

      <label className="field">
        <span>Duration · {seconds.toFixed(1)} s</span>
        <input
          type="range"
          min={MIN_SECONDS}
          max={MAX_SECONDS}
          step={0.5}
          value={seconds}
          onChange={(e) => setSeconds(Number(e.target.value))}
        />
      </label>
      <div className="hint" style={{ marginTop: -4 }}>
        {MIN_SECONDS}–{MAX_SECONDS} seconds. The result is a looping animated mannequin; select it afterwards for
        Motion → Pose strip.
      </div>

      <button
        type="button"
        className="primary"
        onClick={onGenerate}
        disabled={Boolean(blockReason)}
        title={blockReason ?? undefined}
      >
        Generate motion
      </button>
      {blockReason && <div className="hint">{blockReason}</div>}

      {note && <div className="notice">{note}</div>}
    </div>
  );
}
