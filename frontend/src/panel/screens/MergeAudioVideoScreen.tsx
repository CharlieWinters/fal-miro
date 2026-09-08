import { useMemo, useState } from 'react';
import { startAgentJob } from '../communication';
import { useSelectedItems } from '../hooks/useSelection';
import { unwrapAudioEmbedUrl, unwrapVideoEmbedUrl } from '../../lib/api';
import type { FalModel } from '../../shared/falCatalog';

type EmbedItem = { id: string; url?: string; title?: string };

/**
 * Merge Audio + Video — lay an audio track over a Fal video via
 * fal-ai/ffmpeg-api/merge-audio-video. The video comes from the selected board
 * embed; the audio from a selected Fal audio embed (Text→Audio output), or
 * from a pasted URL for clips hosted elsewhere.
 */
export function MergeAudioVideoScreen({ model }: { model: FalModel }) {
  // Select a Fal video and a Fal audio clip together on the board (shift-click)
  // and both are picked up here; a pasted URL is the fallback for audio that
  // lives elsewhere.
  const selectedEmbeds = useSelectedItems<EmbedItem>('embed');
  const [pastedAudioUrl, setPastedAudioUrl] = useState('');
  const [note, setNote] = useState<string | null>(null);

  const selected = useMemo(
    () => selectedEmbeds.find((e) => e.url && unwrapVideoEmbedUrl(e.url)) ?? null,
    [selectedEmbeds],
  );
  const videoUrl = useMemo(() => (selected?.url ? unwrapVideoEmbedUrl(selected.url) : null), [selected]);
  const selectedAudio = useMemo(
    () => selectedEmbeds.find((e) => e.url && unwrapAudioEmbedUrl(e.url)) ?? null,
    [selectedEmbeds],
  );
  const audioUrl = useMemo(
    () => (selectedAudio?.url ? unwrapAudioEmbedUrl(selectedAudio.url) : null) ?? pastedAudioUrl.trim(),
    [selectedAudio, pastedAudioUrl],
  );
  const audioOk = /^https?:\/\/.+/.test(audioUrl);

  /** Why Merge can't run yet, or null — drives the disabled button. */
  const blockReason: string | null = !videoUrl || !selected
    ? 'Select a Fal video on the board first.'
    : !audioOk
      ? 'Select a Fal audio clip on the board too (shift-click), or paste an audio URL.'
      : null;

  const onMerge = () => {
    setNote(null);
    if (!videoUrl || !selected) {
      setNote('Select a Fal video on the board.');
      return;
    }
    if (!audioOk) {
      setNote('Select a Fal audio clip on the board, or paste an audio URL (https://…).');
      return;
    }
    startAgentJob({
      agentId: 'fal_ffmpeg_merge',
      label: `${model.label}`,
      kind: 'video',
      payload: {
        endpointId: model.endpointId,
        input: { video_url: videoUrl, audio_url: audioUrl },
        anchorItemId: selected.id,
        parents: selectedAudio ? [selected.id, selectedAudio.id] : [selected.id],
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

      <div className={`source-image ${selectedAudio ? 'chosen' : ''}`}>
        {selectedAudio ? (
          <>
            <span className="check">✓</span> Using selected audio clip
            {selectedAudio.title ? <span className="src-title"> · {selectedAudio.title}</span> : null}
          </>
        ) : (
          <>Also select a Fal audio clip on the board (shift-click), or paste a URL below.</>
        )}
      </div>

      {!selectedAudio && (
        <label className="field">
          <span>Audio URL</span>
          <input
            type="url"
            placeholder="https://…  (a Fal audio output, or any public audio file)"
            value={pastedAudioUrl}
            onChange={(e) => setPastedAudioUrl(e.target.value)}
          />
        </label>
      )}

      <button
        type="button"
        className="primary"
        onClick={onMerge}
        disabled={Boolean(blockReason)}
        title={blockReason ?? undefined}
      >
        Merge audio + video
      </button>
      {blockReason && <div className="hint">{blockReason}</div>}

      {note && <div className="notice">{note}</div>}
    </div>
  );
}
