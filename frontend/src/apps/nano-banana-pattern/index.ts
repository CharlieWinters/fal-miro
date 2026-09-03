// "Nano Banana Pattern" pipeline app — a single Fal edit call that turns a
// board image (the motif) into a seamless, tileable vector pattern, styled
// by a preset art-style choice and two picked colors.

import { resolveImageUrls, type PipelineAppDef } from '../../shared/pipelineAppTypes';

function str(fixedInputs: Record<string, unknown>, key: string, fallback: string): string {
  const v = fixedInputs[key];
  return typeof v === 'string' && v.trim() ? v.trim() : fallback;
}

/** A small solid-color PNG (data URI) — sent as an image reference rather
 *  than a hex string in the prompt. Models match a color the user actually
 *  picked far more reliably from a swatch image than from text. */
function colorSwatch(hex: string, size = 64): string {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = hex;
    ctx.fillRect(0, 0, size, size);
  }
  return canvas.toDataURL('image/png');
}

export const appDef: PipelineAppDef = {
  id: 'nano-banana-pattern',
  label: 'Nano Banana Pattern',
  boardLayout: true,
  steps: [
    {
      endpointId: 'fal-ai/nano-banana/edit',
      label: 'Generating the pattern…',
      buildInput: async ({ fixedInputs }) => {
        const artStyle = str(fixedInputs, 'artStyle', 'flat mid-century illustration');
        const colorPalette = str(fixedInputs, 'colorPalette', '#FFAA00');
        const backgroundColor = str(fixedInputs, 'backgroundColor', '#FFFFFF');
        // "1" (strictest) – "6" (least strict); Fal defaults to "4" when
        // omitted. Exposed as a control rather than silently overridden —
        // it's a real per-request knob on this model, not a workaround.
        const safetyTolerance = str(fixedInputs, 'safetyTolerance', '');
        const motifUrls = await resolveImageUrls([fixedInputs.coreMotifItemId]);
        return {
          prompt:
            'A seamless repeating vector pattern featuring the motif from the first attached image, ' +
            `arranged in a clean geometric grid, ${artStyle}, using the color shown in the second ` +
            'attached image as the palette, with a solid background matching the color shown in the ' +
            'third attached image, high resolution, tileable texture, crisp clean edges',
          image_urls: [...motifUrls, colorSwatch(colorPalette), colorSwatch(backgroundColor)],
          ...(safetyTolerance ? { safety_tolerance: safetyTolerance } : {}),
        };
      },
      // Match the motif's own shape.
      ratioFromItemId: ({ fixedInputs }) =>
        typeof fixedInputs.coreMotifItemId === 'string' ? fixedInputs.coreMotifItemId : undefined,
    },
  ],
};
