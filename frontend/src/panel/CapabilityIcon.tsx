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
