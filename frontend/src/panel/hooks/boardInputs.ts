// Shared "board inputs" layer — the one place screens reach for board content to
// put into a request. Three primitives, mapping onto whatever a model's schema
// exposes:
//   • single image  → useFirstSelected('image')      ("use the selected image")
//   • image/video array → useBoardReferences()        (bulk, frame-aware)
//   • prompt/text    → usePromptSource()                (stickies → prompt)
//
// Consolidated here so any model screen — hand-built or the future generic form
// — gets the same easy selection behaviour instead of reinventing it.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { unwrapVideoEmbedUrl, unwrapAudioEmbedUrl } from '../../lib/api';
import { cachedBoardGet, getConnectedStickyNotes, stripHtml } from '../../shared/boardHelpers';
import { loadPromptSource, savePromptSource, type PromptSource } from '../../shared/storage';

export { useFirstSelected, useSelectedItems } from './useSelection';

/** A board item chosen as an input (id + optional board title). */
export type BoardRef = { id: string; title?: string };

const clean = (t?: string) => (t ?? '').trim() || undefined;

/**
 * Collect input references from the current selection: selected images,
 * video embeds, and audio embeds, plus everything inside any selected frame —
 * so you can drop refs into a "References" frame, select it, and grab them
 * all in one click. Ordering follows board read order.
 */
export async function collectBoardReferences(): Promise<{
  images: BoardRef[];
  videos: BoardRef[];
  audios: BoardRef[];
  /** The single frame the references were collected from, if the selection
   *  was (or resolved through) exactly one frame — lets a generation place
   *  its output below that same frame instead of a specific reference item. */
  frameId?: string;
}> {
  const sel = (await miro.board.getSelection()) as Array<{
    id: string;
    type: string;
    url?: string;
    title?: string;
    parentId?: string;
  }>;
  const images = new Map<string, BoardRef>();
  const videos = new Map<string, BoardRef>();
  const audios = new Map<string, BoardRef>();
  const frameIds: string[] = [];

  const add = (it: { id: string; type: string; url?: string; title?: string }) => {
    if (it.type === 'image') images.set(it.id, { id: it.id, title: clean(it.title) });
    else if (it.type === 'embed' && it.url && unwrapVideoEmbedUrl(it.url))
      videos.set(it.id, { id: it.id, title: clean(it.title) });
    else if (it.type === 'embed' && it.url && unwrapAudioEmbedUrl(it.url))
      audios.set(it.id, { id: it.id, title: clean(it.title) });
    else if (it.type === 'frame') frameIds.push(it.id);
  };
  sel.forEach(add);

  if (frameIds.length) {
    const [imgs, embeds] = await Promise.all([cachedBoardGet('image'), cachedBoardGet('embed')]);
    for (const it of imgs as Array<BoardRef & { parentId?: string }>) {
      if (it.parentId && frameIds.includes(it.parentId)) images.set(it.id, { id: it.id, title: clean(it.title) });
    }
    for (const it of embeds as Array<BoardRef & { parentId?: string; url?: string }>) {
      if (!it.parentId || !frameIds.includes(it.parentId) || !it.url) continue;
      if (unwrapVideoEmbedUrl(it.url)) videos.set(it.id, { id: it.id, title: clean(it.title) });
      else if (unwrapAudioEmbedUrl(it.url)) audios.set(it.id, { id: it.id, title: clean(it.title) });
    }
  }

  return {
    images: [...images.values()],
    videos: [...videos.values()],
    audios: [...audios.values()],
    frameId: frameIds.length === 1 ? frameIds[0] : undefined,
  };
}

type BoardRefs = { images: BoardRef[]; videos: BoardRef[]; audios: BoardRef[]; frameId?: string };

/** Live board references (images + video/audio embeds), refreshed on selection change. */
export function useBoardReferences(): BoardRefs {
  const [refs, setRefs] = useState<BoardRefs>({ images: [], videos: [], audios: [] });

  useEffect(() => {
    let mounted = true;
    const apply = () => {
      collectBoardReferences()
        .then((r) => mounted && setRefs(r))
        .catch((e) => console.warn('[boardInputs] collect failed', e));
    };
    apply();
    const handler = () => apply();
    miro.board.ui.on('selection:update', handler);
    return () => {
      mounted = false;
      try {
        miro.board.ui.off('selection:update', handler);
      } catch {
        /* older SDKs */
      }
    };
  }, []);

  return refs;
}

/** Join sticky text left-to-right by board x (first sticky → start of prompt). */
export function orderedStickyText(items: Array<{ content?: string; x?: number }>): string {
  return items
    .slice()
    .sort((a, b) => (a.x ?? 0) - (b.x ?? 0))
    .map((s) => stripHtml(s.content ?? ''))
    .filter(Boolean)
    .join('\n');
}

export type SelectedSticky = { id: string; content?: string; x?: number };

/**
 * Selected sticky notes, plus any sticky note inside a selected frame — same
 * frame-expansion rule as `collectBoardReferences`, so a prompt sticky left
 * inside a "prompt frame" is picked up the moment the frame (or its card) is
 * selected, not just when the sticky itself is.
 *
 * Sticky notes only. Doc-format items used to be folded in here too, read via
 * a backend Miro OAuth token — the Web SDK exposes no accessor for them at
 * all. That whole path was dropped to keep the app deployable with nothing
 * but a Fal key; paste the text into a sticky instead.
 */
export async function collectSelectedStickies(): Promise<SelectedSticky[]> {
  const sel = (await miro.board.getSelection()) as Array<SelectedSticky & { type: string }>;
  const stickies = new Map<string, SelectedSticky>();
  const frameIds: string[] = [];

  for (const it of sel) {
    if (it.type === 'sticky_note') stickies.set(it.id, it);
    else if (it.type === 'frame') frameIds.push(it.id);
  }

  if (frameIds.length) {
    const stickyItems = (await cachedBoardGet('sticky_note')) as Array<SelectedSticky & { parentId?: string }>;
    for (const it of stickyItems) {
      if (it.parentId && frameIds.includes(it.parentId)) stickies.set(it.id, it);
    }
  }

  return [...stickies.values()];
}

/** Live sticky-note selection, frame-expanded (see `collectSelectedStickies`),
 *  refreshed on selection change. The raw list, ordered/joined by callers as
 *  needed — `usePromptSource` below is what turns it into prompt text. */
export function useBoardStickies(): SelectedSticky[] {
  const [stickies, setStickies] = useState<SelectedSticky[]>([]);

  useEffect(() => {
    let mounted = true;
    const apply = () => {
      collectSelectedStickies()
        .then((s) => mounted && setStickies(s))
        .catch((e) => console.warn('[boardInputs] collectSelectedStickies failed', e));
    };
    apply();
    const handler = () => apply();
    miro.board.ui.on('selection:update', handler);
    return () => {
      mounted = false;
      try {
        miro.board.ui.off('selection:update', handler);
      } catch {
        /* older SDKs */
      }
    };
  }, []);

  return stickies;
}

// ---------------------------------------------------------------------------
// Prompt source — the explicit replacement for the old always-on autofill.
//
// It used to be a hidden waterfall: selected stickies won, else stickies
// connected to the source image, else nothing — and whatever it found
// silently overwrote whatever you had typed. Those two sources are now modes
// the user picks, and 'off' (the default) means the box is theirs.
// ---------------------------------------------------------------------------

/** One sticky feeding the prompt, in the order it contributes. */
export type PromptNote = { id: string; label: string };

export type PromptSourceState = {
  mode: PromptSource;
  setMode: (m: PromptSource) => void;
  /** Text the board is currently supplying — '' when off, or when a live mode finds nothing. */
  text: string;
  /** The stickies behind `text`, for the chips under the field. */
  notes: PromptNote[];
  /** A live mode is on but the board has nothing to give it. */
  isEmpty: boolean;
  /** First contributing sticky — what a generated result gets anchored to. */
  anchorId?: string;
};

/**
 * Resolve the prompt text for the active source mode.
 *
 * `sourceItemId` is the image/video the screen is working from; 'connected'
 * reads the stickies wired to it. Passing undefined leaves 'connected'
 * permanently empty, which is the honest behaviour for a screen with no
 * single source item (e.g. a pure text-to-image model).
 */
export function usePromptSource(sourceItemId?: string): PromptSourceState {
  const [mode, setModeState] = useState<PromptSource>(() => loadPromptSource());
  const selected = useBoardStickies();
  const [connected, setConnected] = useState<PromptNote[]>([]);

  const setMode = useCallback((m: PromptSource) => {
    setModeState(m);
    savePromptSource(m);
  }, []);

  // Connector lookups hit the board API, so only run them in the mode that
  // needs them — 'selection' and 'off' cost nothing.
  useEffect(() => {
    if (mode !== 'connected' || !sourceItemId) {
      setConnected([]);
      return;
    }
    let live = true;
    void (async () => {
      const notes = await getConnectedStickyNotes(sourceItemId);
      if (!live) return;
      setConnected(
        notes
          .map((n) => ({ id: n.id, label: (n.content ?? '').trim() }))
          .filter((n) => n.label.length > 0),
      );
    })();
    return () => {
      live = false;
    };
  }, [mode, sourceItemId]);

  return useMemo(() => {
    if (mode === 'off') {
      return { mode, setMode, text: '', notes: [], isEmpty: false };
    }
    const notes: PromptNote[] =
      mode === 'selection'
        ? [...selected]
            .sort((a, b) => (a.x ?? 0) - (b.x ?? 0))
            .map((s) => ({ id: s.id, label: stripHtml(s.content ?? '').trim() }))
            .filter((n) => n.label.length > 0)
        : connected;
    return {
      mode,
      setMode,
      text: notes.map((n) => n.label).join('\n'),
      notes,
      isEmpty: notes.length === 0,
      anchorId: notes[0]?.id,
    };
  }, [mode, setMode, selected, connected]);
}

/** The current selection as prompt text, for the one-shot "pull once" action. */
export function useSelectionSnapshot(): () => { text: string; count: number; anchorId?: string } {
  const selected = useBoardStickies();
  return useCallback(() => {
    const ordered = [...selected].sort((a, b) => (a.x ?? 0) - (b.x ?? 0));
    return { text: orderedStickyText(ordered), count: ordered.length, anchorId: ordered[0]?.id };
  }, [selected]);
}
