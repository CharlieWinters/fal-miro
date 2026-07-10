// Curated subset of Meshy's animation library (IDs 0–696). Used by the rigging
// screen's preset picker and to label the resulting clips. Walking + Running
// always come free from the endpoint's `basic_animations`, so they're not here.
// Full library: https://docs.meshy.ai/en/api/animation-library

export type MeshyPreset = { id: number; name: string };

export const MESHY_PRESETS: MeshyPreset[] = [
  { id: 0, name: 'Idle' },
  { id: 106, name: 'Confident Walk' },
  { id: 14, name: 'Run' },
  { id: 28, name: 'Wave Hello' },
  { id: 44, name: 'Happy Jump' },
  { id: 466, name: 'Regular Jump' },
  { id: 87, name: 'Boxing' },
  { id: 22, name: 'Dancing' },
  { id: 326, name: 'Jumping Jacks' },
  { id: 206, name: 'Kick' },
];

/** action_id → friendly name, for labelling generated clips. */
export const MESHY_ACTION_NAMES: Record<number, string> = Object.fromEntries(
  MESHY_PRESETS.map((p) => [p.id, p.name]),
);

/**
 * Build the {name, url} clip list from a Meshy rigging result payload. Each
 * clip is a standalone animated .glb. Walking/Running come from
 * `basic_animations`; the rest map from `animations[].action_id`.
 */
export function extractAnimations(data: unknown): Array<{ name: string; url: string }> {
  const d = (data ?? {}) as Record<string, any>;
  const pick = (f: any): string | null =>
    f && typeof f === 'object' && typeof f.url === 'string' ? f.url : null;
  const out: Array<{ name: string; url: string }> = [];
  const ba = d.basic_animations ?? {};
  const walk = pick(ba.walking_glb);
  const run = pick(ba.running_glb);
  if (walk) out.push({ name: 'Walking', url: walk });
  if (run) out.push({ name: 'Running', url: run });
  if (Array.isArray(d.animations)) {
    for (const c of d.animations) {
      const u = pick(c?.animation_glb);
      if (u) out.push({ name: MESHY_ACTION_NAMES[c?.action_id] ?? `Action ${c?.action_id}`, url: u });
    }
  }
  if (out.length === 0) {
    const rigged = pick(d.rigged_character_glb);
    if (rigged) out.push({ name: 'Rigged (bind pose)', url: rigged });
  }
  return out;
}

/** The rest-pose rig glb (no animation) — best source for manual FK posing. */
export function extractRestPose(data: unknown): string | null {
  const d = (data ?? {}) as Record<string, any>;
  const pick = (f: any): string | null =>
    f && typeof f === 'object' && typeof f.url === 'string' ? f.url : null;
  const ba = d.basic_animations ?? {};
  const firstAnim =
    Array.isArray(d.animations) && d.animations.length ? pick(d.animations[0]?.animation_glb) : null;
  // Prefer the un-animated rig; fall back to any animation glb (same skeleton).
  return pick(d.rigged_character_glb) ?? pick(ba.walking_glb) ?? firstAnim;
}
