import { useMemo, useState } from 'react';
import { startAgentJob } from '../communication';
import { useSelectedItems } from '../hooks/useSelection';
import { unwrapVideoEmbedUrl } from '../../lib/api';
import type { FalModel } from '../../shared/falCatalog';

type EmbedItem = { id: string; url?: string; x?: number; title?: string };

/**
 * Merge Videos — concatenate 2+ Fal videos already on the board. The user
 * multi-selects video embeds; they're ordered left-to-right (play order) and
 * their underlying URLs sent to fal-ai/ffmpeg-api/merge-videos.
 */
export function MergeVideosScreen({ model }: { model: FalModel }) {
  const selectedEmbeds = useSelectedItems<EmbedItem>('embed');
  const [note, setNote] = useState<string | null>(null);

  // Only Fal video embeds (ordered left-to-right = play order).
  const videos = useMemo(
    () =>
      selectedEmbeds
        .map((e) => ({ ...e, videoUrl: e.url ? unwrapVideoEmbedUrl(e.url) : null }))
        .filter((e): e is EmbedItem & { videoUrl: string } => Boolean(e.videoUrl))
        .sort((a, b) => (a.x ?? 0) - (b.x ?? 0)),
    [selectedEmbeds],
  );

  const onMerge = () => {
    setNote(null);
    if (videos.length < 2) {
      setNote('Select 2 or more Fal videos on the board (shift-click to add several).');
      return;
    }
    startAgentJob({
      agentId: 'fal_ffmpeg_merge',
      label: `${model.label} · ${videos.length} clips`,
      kind: 'video',
      payload: {
        endpointId: model.endpointId,
        input: { video_urls: videos.map((v) => v.videoUrl) },
        anchorItemId: videos[0].id,
        parents: videos.map((v) => v.id),
      },
    });
    setNote('Merging videos — the combined clip will drop on the board when it’s ready.');
  };

  return (
    <div className="screen">
      <div className="hero">
        <div className="title">{model.label}</div>
        <div className="sub">{model.endpointId}</div>
      </div>

      <div className="notice">
        Select the Fal videos to join, in order — they’re concatenated left-to-right by their
        position on the board.
      </div>

      {videos.length === 0 ? (
        <div className="empty-state">No Fal videos selected. Shift-click videos on the board.</div>
      ) : (
        <div className="view-slots">
          {videos.map((v, i) => (
            <div key={v.id} className="source-image chosen" style={{ textAlign: 'left' }}>
              <span className="check">{i + 1}.</span> {v.title || 'Video'}
            </div>
          ))}
        </div>
      )}

      <button type="button" className="primary" disabled={videos.length < 2} onClick={onMerge}>
        {videos.length >= 2 ? `Merge ${videos.length} videos` : 'Select 2+ videos'}
      </button>

      {note && <div className="notice">{note}</div>}
    </div>
  );
}
