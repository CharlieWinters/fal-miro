import { createElement } from 'react';
import type { Capability } from '../shared/falCatalog';
import { toneOf, toneFill, toneOutline } from '../shared/capabilityTone';

// Per-capability line icons from the Fal Panel redesign — 24×24, stroked (no
// fill), rounded joins. Each entry is a list of [svgTag, attrs].
type El = [string, Record<string, number | string>];

const ICONS: Partial<Record<Capability, El[]>> = {
  image: [
    ['rect', { x: 3, y: 3, width: 18, height: 18, rx: 3 }],
    ['circle', { cx: 8.5, cy: 8.5, r: 1.5 }],
    ['path', { d: 'M21 15l-5-5L5 21' }],
  ],
  video: [
    ['rect', { x: 3, y: 5, width: 18, height: 14, rx: 3 }],
    ['path', { d: 'M10 9l5 3-5 3z' }],
  ],
  model3d: [
    ['path', { d: 'M12 2l8 4.5v9L12 20l-8-4.5v-9z' }],
    ['path', { d: 'M12 11v9' }],
    ['path', { d: 'M20 6.5L12 11 4 6.5' }],
  ],
  panorama: [
    ['circle', { cx: 12, cy: 12, r: 9 }],
    ['path', { d: 'M3 12h18' }],
    ['path', { d: 'M12 3c3 3.5 3 14.5 0 18' }],
    ['path', { d: 'M12 3c-3 3.5-3 14.5 0 18' }],
  ],
  segment: [
    ['circle', { cx: 6, cy: 6, r: 2.6 }],
    ['circle', { cx: 6, cy: 18, r: 2.6 }],
    ['path', { d: 'M8.4 7.6L20 18' }],
    ['path', { d: 'M8.4 16.4L20 6' }],
  ],
  rig: [
    ['circle', { cx: 12, cy: 4.5, r: 1.6 }],
    ['path', { d: 'M12 7v6' }],
    ['path', { d: 'M8 20l4-7 4 7' }],
    ['path', { d: 'M9 10.5h6' }],
  ],
  // Running figure — text-to-motion clips.
  motion: [
    ['circle', { cx: 14.5, cy: 4, r: 1.6 }],
    ['path', { d: 'M13 7.5l-3.5 2.5 2 3.5' }],
    ['path', { d: 'M13 7.5l3 2.5 3 1' }],
    ['path', { d: 'M11.5 13.5L8 16l-2.5 4.5' }],
    ['path', { d: 'M11.5 13.5l3 3 .5 4' }],
  ],
  merge: [
    ['path', { d: 'M12 3l9 5-9 5-9-5z' }],
    ['path', { d: 'M3 13l9 5 9-5' }],
  ],
  sound: [
    ['path', { d: 'M4 9v6h4l5 4V5L8 9z' }],
    ['path', { d: 'M16 8.5a5 5 0 0 1 0 7' }],
    ['path', { d: 'M18.5 6a9 9 0 0 1 0 12' }],
  ],
  music: [
    ['path', { d: 'M9 18V5l10-2v13' }],
    ['circle', { cx: 6, cy: 18, r: 3 }],
    ['circle', { cx: 16, cy: 16, r: 3 }],
  ],
  audio: [
    ['rect', { x: 9, y: 2, width: 6, height: 11, rx: 3 }],
    ['path', { d: 'M5 10a7 7 0 0 0 14 0' }],
    ['path', { d: 'M12 17v4' }],
    ['path', { d: 'M8 21h8' }],
  ],
  // Chat bubble + text lines — LLM/text-reasoning models.
  llm: [
    ['path', { d: 'M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-4 4v-4H6a2 2 0 0 1-2-2z' }],
    ['path', { d: 'M8 8h8' }],
    ['path', { d: 'M8 11.5h5' }],
  ],
  // Eye — vision/captioning models (image-to-text, video-to-text, etc.).
  vision: [
    ['path', { d: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z' }],
    ['circle', { cx: 12, cy: 12, r: 3 }],
  ],
  // Braces — structured-data in/out (JSON) models.
  data: [
    ['path', { d: 'M8 3C6 3 5 4 5 6v2c0 1.5-1 2-2 2 1 0 2 .5 2 2v2c0 2 1 3 3 3' }],
    ['path', { d: 'M16 3c2 0 3 1 3 3v2c0 1.5 1 2 2 2-1 0-2 .5-2 2v2c0 2-1 3-3 3' }],
  ],
  // Rising line chart — training/fine-tuning jobs.
  training: [
    ['path', { d: 'M3 3v18h18' }],
    ['path', { d: 'M7 15l4-4 3 3 6-7' }],
  ],
  // Connected nodes — multi-step workflows/pipelines.
  workflow: [
    ['rect', { x: 3, y: 3, width: 6, height: 6, rx: 1.5 }],
    ['rect', { x: 15, y: 3, width: 6, height: 6, rx: 1.5 }],
    ['rect', { x: 9, y: 15, width: 6, height: 6, rx: 1.5 }],
    ['path', { d: 'M6 9v2a3 3 0 0 0 3 3' }],
    ['path', { d: 'M18 9v2a3 3 0 0 1-3 3' }],
  ],
  // Question mark — uncategorized/unknown.
  other: [
    ['circle', { cx: 12, cy: 12, r: 9 }],
    ['path', { d: 'M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7v.3' }],
    ['path', { d: 'M12 17h.01' }],
  ],
};

/** The capability icon in a tone-tinted rounded chip (modal headers, cards). */
export function ToneIconChip({
  capability,
  size = 36,
  iconSize = 18,
}: {
  capability: Capability;
  size?: number;
  iconSize?: number;
}) {
  const tone = toneOf(capability);
  return (
    <span
      className="tone-chip"
      style={{ width: size, height: size, background: toneFill(tone), border: `1px solid ${toneOutline(tone)}` }}
    >
      <CapabilityIcon capability={capability} color={tone} size={iconSize} />
    </span>
  );
}

export function CapabilityIcon({
  capability,
  color,
  size = 20,
}: {
  capability: Capability;
  color: string;
  size?: number;
}) {
  const els = ICONS[capability];
  if (!els) return null;
  return createElement(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: color,
      strokeWidth: 1.6,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      style: { flex: '0 0 auto' },
    },
    els.map((c, i) => createElement(c[0], { key: i, ...c[1] })),
  );
}
