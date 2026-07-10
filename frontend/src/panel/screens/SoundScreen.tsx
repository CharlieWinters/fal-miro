import { useMemo, useState } from 'react';
import { startAgentJob } from '../communication';
import { useFirstSelected } from '../hooks/useSelection';
import { unwrapVideoEmbedUrl } from '../../lib/api';
import type { FalModel } from '../../shared/falCatalog';

type EmbedItem = { id: string; url?: string; title?: string };

/**
 * Video → Sound — generate a soundtrack / foley for a Fal video already on the
 * board. The chosen model returns the same video with audio muxed in, so the
 * result drops as a normal video embed (reusing the FFmpeg-merge agent, which
 * runs an endpoint and places the resulting video).
 *
 * ThinkSound derives the sound automatically (prompt optional); MMAudio and
 * Hunyuan Foley take a prompt describing the desired sound.
 */
export function SoundScreen({ model }: { model: FalModel }) {
  const selected = useFirstSelected<EmbedItem>('embed');
  const [prompt, setPrompt] = useState('');
  const [note, setNote] = useState<string | null>(null);

  const videoUrl = useMemo(() => (selected?.url ? unwrapVideoEmbedUrl(selected.url) : null), [selected]);
  const promptField = model.endpointId.includes('foley') ? 'text_prompt' : 'prompt';
  const promptRequired = !model.endpointId.includes('thinksound');

  const onGenerate = () => {
    setNote(null);
    if (!videoUrl || !selected) {
      setNote('Select a Fal video on the board.');
      return;
    }
    const trimmed = prompt.trim();
    if (promptRequired && !trimmed) {
      setNote('Describe the sound you want (this model needs a prompt).');
      return;
    }
    const input: Record<string, unknown> = { video_url: videoUrl };
    if (trimmed) input[promptField] = trimmed;

    startAgentJob({
      agentId: 'fal_ffmpeg_merge',
      label: `${model.label}`,
      kind: 'video',
      payload: {
        endpointId: model.endpointId,
        input,
        anchorItemId: selected.id,
        parents: [selected.id],
        placeholderLabel: 'Adding sound…',
      },
    });
    setNote('Generating sound — the video with audio will drop on the board when it’s ready.');
  };

  return (
    <div className="screen">
      <div className="hero">
        <div className="title">{model.label}</div>
        <div className="sub">{model.endpointId}</div>
      </div>

      <div className={`source-image ${videoUrl ? 'chosen' : ''}`}>
        {videoUrl ? (
          <>
            <span className="check">✓</span> Using selected video
            {selected?.title ? <span className="src-title"> · {selected.title}</span> : null}
          </>
        ) : (
          <>Select a Fal video on the board.</>
        )}
      </div>

      <label className="field">
        <span>Sound prompt{promptRequired ? '' : ' (optional)'}</span>
        <textarea
          rows={3}
          placeholder="e.g. footsteps on gravel, distant traffic, wind"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
      </label>
      <div className="hint" style={{ marginTop: -4 }}>
        {promptRequired
          ? 'Describe the sound to generate for this clip.'
          : 'ThinkSound infers the sound from the video — a prompt is optional.'}{' '}
        The result is the same video with audio added.
      </div>

      <button type="button" className="primary" onClick={onGenerate}>
        Add sound
      </button>

      {note && <div className="notice">{note}</div>}
    </div>
  );
}
