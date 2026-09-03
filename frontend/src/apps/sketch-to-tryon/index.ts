// "Sketch to Try-On" pipeline app — sketch + material swatches → a
// photoreal garment render → fitted onto a model. Two chained Fal calls,
// results laid out on the board (see ../../shared/pipelineRunner.ts for how
// any app's steps actually execute — this file only ever describes them).

import { resolveImageUrls, type PipelineAppDef } from '../../shared/pipelineAppTypes';

/** `fixedInputs.materialItemIds` as a plain string array, however it round-tripped. */
function materialItemIds(fixedInputs: Record<string, unknown>): unknown[] {
  return Array.isArray(fixedInputs.materialItemIds) ? fixedInputs.materialItemIds : [];
}

export const appDef: PipelineAppDef = {
  id: 'sketch-to-tryon',
  label: 'Sketch to Try-On',
  boardLayout: true,
  steps: [
    {
      endpointId: 'fal-ai/nano-banana/edit',
      label: 'Rendering the sketch as a realistic garment…',
      buildInput: async ({ fixedInputs }) => ({
        prompt:
          'Turn this fashion sketch into a photorealistic garment photo, rendered using the ' +
          'attached fabric and material swatches for texture, color, and finish. Studio ' +
          'product-shot lighting, plain background.',
        image_urls: await resolveImageUrls([fixedInputs.sketchItemId, ...materialItemIds(fixedInputs)]),
      }),
      // Match the sketch's own shape — it's the subject being rendered.
      ratioFromItemId: ({ fixedInputs }) =>
        typeof fixedInputs.sketchItemId === 'string' ? fixedInputs.sketchItemId : undefined,
    },
    {
      endpointId: 'fal-ai/nano-banana/edit',
      label: 'Fitting the garment onto the model…',
      buildInput: async ({ fixedInputs, priorOutputs }) => {
        const modelUrls = await resolveImageUrls([fixedInputs.modelItemId]);
        return {
          prompt:
            "Put the garment shown in the first image onto the person in the second image, " +
            "keeping the person's pose, face, and background unchanged. Realistic fit, lighting, " +
            'and shadows.',
          image_urls: [priorOutputs[0], ...modelUrls].filter((v): v is string => typeof v === 'string' && v.length > 0),
        };
      },
      // Match the model photo's own shape — the final result is the model.
      ratioFromItemId: ({ fixedInputs }) =>
        typeof fixedInputs.modelItemId === 'string' ? fixedInputs.modelItemId : undefined,
    },
  ],
};
