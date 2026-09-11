// One accent tone per capability (from the Fal Panel redesign). Used wherever a
// capability appears — list dots, mode chips, tiles, modal accents, job dots,
// on-board placeholders. The rule (Miro's outline style) is a lighter fill with
// a darker outline of the same tone; hex-alpha suffixes give both from one hex.

import type { Capability } from './falCatalog';

const DEFAULT_TONE = '#8a8a92';

export const CAPABILITY_TONE: Record<Capability, string> = {
  image: '#4BD1F6',
  video: '#CE70FC',
  audio: '#FFB454',
  music: '#FFB454',
  segment: '#FF9C57',
  model3d: '#6EDB8C',
  panorama: '#47D1C4',
  rig: '#F25A6E',
  motion: '#FF8A5B',
  merge: '#FFDD33',
  sound: '#FFB454',
  llm: '#7C9CFF',
  vision: '#FF8FE3',
  data: '#B8E986',
  training: '#FF7A45',
  workflow: '#A78BFA',
  other: DEFAULT_TONE,
};

export function toneOf(capability: Capability | undefined): string {
  return (capability && CAPABILITY_TONE[capability]) || DEFAULT_TONE;
}

/** Lighter fill of a tone (≈20% alpha) for icon-chip backgrounds — matches the
 *  design's `rgba(tone, .2)`. */
export function toneFill(tone: string): string {
  return `${tone}33`;
}

/** Darker outline of a tone (≈45% alpha) for icon-chip borders — matches the
 *  design's `rgba(tone, .45)`. */
export function toneOutline(tone: string): string {
  return `${tone}73`;
}
