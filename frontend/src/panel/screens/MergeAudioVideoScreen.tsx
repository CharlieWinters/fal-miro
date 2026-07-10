import { useMemo, useState } from 'react';
import { startAgentJob } from '../communication';
import { useFirstSelected } from '../hooks/useSelection';
import { unwrapVideoEmbedUrl } from '../../lib/api';
import type { FalModel } from '../../shared/falCatalog';

type EmbedItem = { id: string; url?: string; title?: string };

/**
 * Merge Audio + Video — lay an audio track over a Fal video via
 * fal-ai/ffmpeg-api/merge-audio-video. The video comes from the selected board
 * embed; the audio is a URL for now (paste a Fal audio output). Once Text→Audio
 * lands, audio will be selectable from the board too.
 */
export function MergeAudioVideoScreen({ model }: { model: FalModel }) {
  const selected = useFirstSelected<EmbedItem>('embed');
  const [audioUrl, setAudioUrl] = useState('');
  const [note, setNote] = useState<string | null>(null);

  const videoUrl = useMemo(() => (selected?.url ? unwrapVideoEmbedUrl(selected.url) : null), [selected]);

  const onMerge = () => {
    setNote(null);
    if (!videoUrl || !selected) {
      setNote('Select a Fal video on the board.');
      return;
    }
    if (!/^https?:\/\/.+/.test(audioUrl.trim())) {
      setNote('Paste an audio URL (https://…) to lay over the video.');
      return;
    }
    startAgentJob({
      agentId: 'fal_ffmpeg_merge',
      label: `${model.label}`,
      kind: 'video',
      payload: {
        endpointId: model.endpointId,
        input: { video_url: videoUrl, audio_url: audioUrl.trim() },
        anchorItemId: selected.id,
        parents: [selected.id],
      },
    });
    setNote('Merging audio + video — the result will drop on the board when it’s ready.');
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
        <span>Audio URL</span>
        <input
          type="url"
          placeholder="https://…  (a Fal audio output, or any public audio file)"
          value={audioUrl}
          onChange={(e) => setAudioUrl(e.target.value)}
        />
      </label>
      <div className="hint">
        Audio isn’t on the board yet — paste a URL for now. Once Text→Audio is wired up, you’ll
        select the audio clip on the board like the video.
      </div>

      <button type="button" className="primary" onClick={onMerge}>
        Merge audio + video
      </button>

      {note && <div className="notice">{note}</div>}
    </div>
  );
}
