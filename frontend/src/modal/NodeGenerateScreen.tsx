import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { startAgentJob } from '../panel/communication';
import { findModel, isBlendReference, isReferenceToVideo, type FalModel } from '../shared/falCatalog';
import { getConnectedResources, getParentFrameId } from '../shared/boardHelpers';
import { estimateCostUSD } from '../shared/cost';
import { readNode } from '../shared/nodeBoard';
import { buildRecipeSeed, seedFormState } from '../shared/recipeCard';
import { buildRefVideoInput, refVideoPayload } from '../shared/refVideoJob';
import { videoReferenceCaps } from '../shared/referenceBinding';
import {
  defaultsFor,
  parseFalInputSchema,
  pickAudioReferenceField,
  pickReferenceField,
  pickVideoReferenceField,
} from '../shared/schema';

/**
 * The confirm step for Generate on an embed node.
 *
 * A node on the board can ask for this modal, and that is all it can do: the
 * run is rebuilt here from the board (the node's metadata, its connectors and
 * frame, the model's live schema), the same way ReferenceToVideoScreen builds
 * it, and starts only when the director clicks Generate. That click, in an app
 * surface, is what stands between "any page on this origin can message the
 * app" and spending someone's Fal credits.
 */

type Plan = {
  title: string;
  modelLabel: string;
  settings: Array<[string, string]>;
  prompt: string;
  refs: { images: string[]; videos: string[]; audios: string[] };
  costUSD?: number;
  label: string;
  payload: Record<string, unknown>;
};

type State = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; plan: Plan };

async function buildPlan(embedId: string): Promise<Plan> {
  const node = await readNode(embedId);
  if (!node) throw new Error('This node is no longer on the board.');
  const { recipe, title } = node.meta;
  const model: FalModel =
    findModel(recipe.endpointId) ??
    ({ endpointId: recipe.endpointId, label: recipe.endpointId, capability: recipe.capability } as FalModel);
  if (!isReferenceToVideo(model)) {
    throw new Error('Generate on the node works for reference-to-video models for now. Use Open in Fal for this one.');
  }

  const schema = await api.getSchema(recipe.endpointId);
  const fields = parseFalInputSchema(schema.openapi);
  const blend = isBlendReference(model);
  const imageRefField = pickReferenceField(fields);
  const videoRefField = blend ? null : pickVideoReferenceField(fields);
  const audioField = blend ? null : pickAudioReferenceField(fields);
  const referenceFieldNames = [imageRefField?.name, videoRefField?.name, audioField?.name].filter(
    (n): n is string => Boolean(n),
  );
  if (referenceFieldNames.length === 0) throw new Error('This model declares no reference field the app recognises.');
  const caps = videoReferenceCaps(recipe.endpointId, {
    images: imageRefField ? (imageRefField.multiple ? imageRefField.maxItems : 1) : undefined,
    videos: videoRefField ? (videoRefField.multiple ? videoRefField.maxItems : 1) : undefined,
    audios: audioField ? (audioField.multiple ? audioField.maxItems : 1) : undefined,
  });

  const [connected, frameId] = await Promise.all([getConnectedResources(embedId), getParentFrameId(embedId)]);
  const seed = buildRecipeSeed(recipe, embedId, connected, frameId);
  const { prompt: seedPrompt, values: merged } = seedFormState(seed, fields);
  const values = { ...defaultsFor(fields), ...merged };
  const prompt = (seedPrompt ?? '').trim();

  const images = seed.images.slice(0, caps.images);
  const videos = videoRefField ? seed.videos.slice(0, caps.videos) : [];
  const audios = audioField ? seed.audios.slice(0, caps.audios) : [];
  if (!images.length && !videos.length && !audios.length) {
    throw new Error('Nothing is wired to this node. Draw a line from each reference to it, or put them in its frame.');
  }
  if (!prompt) throw new Error('This node has no prompt. Wire a sticky to it, or save one from the panel.');

  const input = buildRefVideoInput(fields, values, referenceFieldNames);
  input.prompt = prompt;
  const seconds = Number(input.duration) || undefined;
  const costUSD = await estimateCostUSD(recipe.endpointId, { units: 1, seconds });

  const settings: Array<[string, string]> = [];
  for (const [k, label] of [
    ['aspect_ratio', 'Aspect'],
    ['resolution', 'Resolution'],
    ['duration', 'Duration'],
  ] as const) {
    if (input[k] !== undefined) settings.push([label, k === 'duration' ? `${input[k]} s` : String(input[k])]);
  }
  const name = (r: { title?: string }) => r.title?.trim() || 'untitled';

  return {
    title: title || 'Fal node',
    modelLabel: model.label,
    settings,
    prompt,
    refs: { images: images.map(name), videos: videos.map(name), audios: audios.map(name) },
    costUSD,
    label: `${title || 'Node'} · ${model.label}`,
    payload: refVideoPayload({
      endpointId: recipe.endpointId,
      input,
      values,
      images,
      videos,
      audios,
      blend,
      imageRefField,
      videoRefField,
      audioField,
      cardAnchorId: embedId,
      ...(frameId ? { referenceFrameId: frameId } : {}),
    }),
  };
}

export function NodeGenerateScreen({ embedId, onClose }: { embedId: string; onClose: () => void }) {
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    let live = true;
    buildPlan(embedId)
      .then((plan) => live && setState({ status: 'ready', plan }))
      .catch((e) => live && setState({ status: 'error', message: e instanceof Error ? e.message : String(e) }));
    return () => {
      live = false;
    };
  }, [embedId]);

  if (state.status === 'loading') {
    return (
      <div className="screen">
        <div className="hero">
          <div className="title">Generate</div>
          <div className="sub">Reading the node and its references…</div>
        </div>
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <div className="screen">
        <div className="hero">
          <div className="title">Can’t generate yet</div>
        </div>
        <div className="notice">{state.message}</div>
        <div className="button-row">
          <button type="button" className="secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    );
  }

  const { plan } = state;
  const cost = plan.costUSD !== undefined ? `about $${plan.costUSD.toFixed(2)}` : 'cost unknown';
  const generate = () => {
    startAgentJob({ agentId: 'fal_video_gen', label: plan.label, kind: 'video', payload: plan.payload });
    onClose();
  };
  const refLines = [
    ...plan.refs.images.map((t) => `Image · ${t}`),
    ...plan.refs.videos.map((t) => `Video · ${t}`),
    ...plan.refs.audios.map((t) => `Audio · ${t}`),
  ];

  return (
    <div className="screen">
      <div className="hero">
        <div className="title">{plan.title}</div>
        <div className="sub">{plan.modelLabel}</div>
      </div>
      {plan.settings.length > 0 && (
        <div className="hint">{plan.settings.map(([k, v]) => `${k} ${v}`).join(' · ')}</div>
      )}
      <span className="label">References · {refLines.length}</span>
      <div className="hint">
        {refLines.map((l) => (
          <div key={l}>{l}</div>
        ))}
      </div>
      <span className="label">Prompt</span>
      <div className="hint" style={{ whiteSpace: 'pre-wrap' }}>
        {plan.prompt}
      </div>
      <div className="button-row">
        <button type="button" className="secondary" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="primary" onClick={generate}>
          Generate video · {cost}
        </button>
      </div>
      <div className="hint">The result lands beside the node, and the node shows it when it’s done.</div>
    </div>
  );
}
