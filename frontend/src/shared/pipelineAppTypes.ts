// Shared types + helpers every pipeline app definition builds on. Kept
// separate from shared/pipelineApps.ts (the registry aggregator) to avoid a
// circular import: each app under src/apps/<id>/ needs these, and the
// aggregator needs each app's definition.

import { getImageRef } from './boardHelpers';

export type PipelineStepDef = {
  endpointId: string;
  /** Shown in progress messages while this step runs. */
  label: string;
  /** This step's Fal input, built from the run's fixed inputs plus every
   *  prior step's output URL (in order). `fixedInputs` holds small values only
   *  (e.g. board item ids) — it's persisted to board appData (~30 KB cap) and
   *  re-read from that persisted copy whenever a step starts after the first,
   *  so anything large (like a resolved image) never belongs in it. Resolve
   *  ids to real image data here, right when this step actually needs it. */
  buildInput: (ctx: {
    fixedInputs: Record<string, unknown>;
    priorOutputs: string[];
  }) => Promise<Record<string, unknown>> | Record<string, unknown>;
  /** The board item (from fixedInputs) whose shape this step's placeholder —
   *  and, where the model has a matching field, the actual generation
   *  request — should match. E.g. the sketch for a sketch-to-image step, the
   *  model photo for a try-on step. Omit to just use a 1:1 placeholder. */
  ratioFromItemId?: (ctx: { fixedInputs: Record<string, unknown> }) => string | undefined;
};

export type PipelineAppDef = {
  id: string;
  label: string;
  /** Does this app lay its steps' outputs out on the board (a visual trail),
   *  or keep everything inside its own panel screen? */
  boardLayout: boolean;
  steps: PipelineStepDef[];
};

/** Resolve board item ids to their image data — the common case for a
 *  step's buildInput. */
export async function resolveImageUrls(itemIds: unknown[]): Promise<string[]> {
  const ids = itemIds.filter((v): v is string => typeof v === 'string' && v.length > 0);
  const refs = await Promise.all(ids.map((id) => getImageRef(id)));
  return refs.filter((r): r is NonNullable<typeof r> => Boolean(r)).map((r) => r.url);
}
