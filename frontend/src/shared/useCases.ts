// Use-case curation layer.
//
// A "use case" is an intent-first shortcut (fal's search-chip idea: "Generate a
// 3D model", "Remove background", "Try on clothing"). It resolves to one or more
// model + task targets in the catalog. Browse ▸ Use case surfaces these; a
// single target opens the task directly, several offer a chooser.
//
// Seeded from fal's Explore chips, mapped onto the models we actually ship. New
// use cases are just data — add a row here.

import { enabledModels, type Capability, type FalModel } from './falCatalog';

export type UseCase = {
  id: string;
  label: string;
  /** Drives the tile's tone/icon. */
  icon: Capability;
  /** Ordered model+task targets; `task` disambiguates duplicate endpoints. */
  targets: Array<{ endpointId: string; task?: string }>;
};

export const USE_CASES: UseCase[] = [
  {
    id: 'generate-image',
    label: 'Generate an image',
    icon: 'image',
    targets: [
      { endpointId: 'fal-ai/nano-banana' },
      { endpointId: 'fal-ai/flux-2-pro' },
      { endpointId: 'fal-ai/bytedance/seedream/v4.5/text-to-image' },
    ],
  },
  {
    id: 'edit-image',
    label: 'Edit an image',
    icon: 'image',
    targets: [
      { endpointId: 'fal-ai/nano-banana/edit' },
      { endpointId: 'fal-ai/bytedance/seedream/v4.5/edit' },
    ],
  },
  {
    id: 'animate-image',
    label: 'Animate an image (image → video)',
    icon: 'video',
    targets: [
      { endpointId: 'fal-ai/veo3.1/image-to-video' },
      { endpointId: 'fal-ai/bytedance/seedance/v1.5/pro/image-to-video', task: 'Image to Video' },
    ],
  },
  {
    id: 'blend-references',
    label: 'Blend references into a shot',
    icon: 'video',
    targets: [
      { endpointId: 'bytedance/seedance-2.0/reference-to-video' },
      { endpointId: 'fal-ai/veo3.1/reference-to-video' },
    ],
  },
  {
    id: 'generate-3d',
    label: 'Generate a 3D model',
    icon: 'model3d',
    targets: [{ endpointId: 'fal-ai/hunyuan3d/v2' }, { endpointId: 'fal-ai/triposr' }],
  },
  {
    id: 'panorama',
    label: 'Make a 360° panorama',
    icon: 'panorama',
    targets: [{ endpointId: 'fal-ai/hunyuan_world' }],
  },
  {
    id: 'rig-animate',
    label: 'Rig & animate a character',
    icon: 'rig',
    targets: [{ endpointId: 'fal-ai/meshy/rigging/multi-animation' }],
  },
  {
    id: 'add-sound',
    label: 'Add sound to a video',
    icon: 'sound',
    targets: [
      { endpointId: 'fal-ai/thinksound' },
      { endpointId: 'fal-ai/mmaudio-v2' },
      { endpointId: 'fal-ai/hunyuan-video-foley' },
    ],
  },
  {
    id: 'remove-background',
    label: 'Remove background / cut out an object',
    icon: 'segment',
    targets: [{ endpointId: 'fal-ai/sam-3/image' }],
  },
  {
    id: 'try-on-clothing',
    // TODO: attach a garment preset prompt once ModelScreen accepts initial values.
    label: 'Try on clothing',
    icon: 'image',
    targets: [{ endpointId: 'fal-ai/nano-banana/edit' }],
  },
];

/** The catalog tasks a use case points to (enabled + resolvable only). */
export function resolveTargets(uc: UseCase): FalModel[] {
  const models = enabledModels();
  const out: FalModel[] = [];
  for (const t of uc.targets) {
    const found = models.find((m) => m.endpointId === t.endpointId && (!t.task || m.task === t.task));
    if (found && !out.includes(found)) out.push(found);
  }
  return out;
}

/** Use cases that resolve to at least one enabled task. */
export function useCasesPresent(): UseCase[] {
  return USE_CASES.filter((uc) => resolveTargets(uc).length > 0);
}
