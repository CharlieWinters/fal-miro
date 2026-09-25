// Build a node's run from the board — the node's metadata, its connectors
// and frame, and the model's live schema — the same way ReferenceToVideoScreen
// builds one from the panel. The headless bridge calls this when a node's
// Generate is pressed, so nothing about the run comes from the message.

import { api } from '../lib/api';
import { findModel, isBlendReference, isReferenceToVideo, type FalModel } from './falCatalog';
import { getConnectedResources, getParentFrameId } from './boardHelpers';
import { estimateCostUSD } from './cost';
import { readNode } from './nodeBoard';
import { buildRecipeSeed, seedFormState } from './recipeCard';
import { buildRefVideoInput, refVideoPayload } from './refVideoJob';
import { videoReferenceCaps } from './referenceBinding';
import {
  defaultsFor,
  parseFalInputSchema,
  pickAudioReferenceField,
  pickReferenceField,
  pickVideoReferenceField,
} from './schema';

export type NodeRunPlan = {
  title: string;
  modelLabel: string;
  settings: Array<[string, string]>;
  prompt: string;
  refs: { images: string[]; videos: string[]; audios: string[] };
  costUSD?: number;
  label: string;
  payload: Record<string, unknown>;
};


export async function buildNodeRun(embedId: string): Promise<NodeRunPlan> {
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
