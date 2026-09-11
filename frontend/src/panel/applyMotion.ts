// "Apply motion to character": a motion embed plus a rigged-character embed
// selected together become a third embed that plays the motion on the
// character. No model call and no cost — the retargeting happens in the
// viewer's browser when the embed page loads (see embed/retarget.ts).
import { motionEmbedUrl, unwrapMotionEmbedUrl, unwrapRigEmbedUrl } from '../lib/api';
import { createEmbedAtPosition, resolveAbsolutePosition } from '../shared/boardHelpers';
import { getItemGenerationSettings, setItemGenerationSettings, type GenSettings } from '../shared/storage';

export type EmbedLike = { id: string; url?: string; title?: string };

/** Split a selection of embeds into the one motion and the one rig it needs, if present. */
export function pickMotionAndRig(embeds: EmbedLike[]): { motion: EmbedLike; rig: EmbedLike } | null {
  const motion = embeds.find((e) => e.url && unwrapMotionEmbedUrl(e.url));
  const rig = embeds.find((e) => e.url && unwrapRigEmbedUrl(e.url));
  return motion && rig ? { motion, rig } : null;
}

/**
 * Create the combined embed to the right of the motion embed. The character
 * file is the rig's rest-pose glb when its metadata has one (a clean bind
 * pose retargets best); otherwise the rig embed's own animated glb, whose
 * skeleton is the same.
 */
export async function applyMotionToCharacter(motion: EmbedLike, rig: EmbedLike): Promise<{ id: string }> {
  const fbxUrl = motion.url ? unwrapMotionEmbedUrl(motion.url) : null;
  const rigGlb = rig.url ? unwrapRigEmbedUrl(rig.url) : null;
  if (!fbxUrl || !rigGlb) throw new Error('Select one motion and one rigged character.');

  const [motionSettings, rigSettings, abs] = await Promise.all([
    getItemGenerationSettings<GenSettings>(motion.id),
    getItemGenerationSettings<GenSettings>(rig.id),
    resolveAbsolutePosition(motion.id),
  ]);
  const characterUrl = rigSettings?.restPoseUrl ?? rigGlb;

  const width = abs?.width || 540;
  const height = abs?.height || 720;
  const x = (abs?.absoluteX ?? 0) + width + 40;
  const y = abs?.absoluteY ?? 0;
  const embed = await createEmbedAtPosition({ url: motionEmbedUrl(fbxUrl, characterUrl), x, y, width, height });
  await setItemGenerationSettings(embed.id, {
    endpointId: motionSettings?.endpointId ?? 'fal-ai/hunyuan-motion',
    input: { ...(motionSettings?.input ?? {}), character_url: characterUrl },
    ratio: motionSettings?.ratio ?? '3:4',
    parents: [motion.id, rig.id],
    // Nothing was generated — the motion and the rig were both paid for already.
    costUSD: 0,
  });
  return { id: embed.id };
}
