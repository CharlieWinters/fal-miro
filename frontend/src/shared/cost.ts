// Cost estimation helpers shared across agents.
//
// Fal gives no per-call price back, so we estimate from the model's published
// unit price (see backend /api/fal/estimate). Image models bill per output;
// video (and other GPU-heavy) models bill by how long the job *ran*, so for
// those we need the elapsed compute time, not the output length.

import { api } from '../lib/api';

/**
 * Seconds of compute Fal reports for a finished job, if present. Many models
 * return a `timings` block (e.g. `{ inference: 23.7 }`); time-billed video
 * models are charged on this rather than on the output's duration. Returns
 * undefined when no timing is present.
 */
export function reportedInferenceSeconds(data: unknown): number | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const d = data as Record<string, unknown>;
  const block = (d.timings ?? d.timing ?? d.metrics) as Record<string, unknown> | undefined;
  if (!block || typeof block !== 'object') return undefined;
  const cand =
    block.inference ?? block.inference_time ?? block.total ?? block.elapsed ?? block.duration;
  return typeof cand === 'number' && cand > 0 ? cand : undefined;
}

/**
 * Best-effort cost in USD; undefined on any error. `seconds` (elapsed compute
 * time) is only used by the backend for time-billed models — harmless to pass
 * otherwise.
 */
export async function estimateCostUSD(
  endpointId: string,
  opts: { units?: number; seconds?: number } = {},
): Promise<number | undefined> {
  try {
    const est = await api.estimate(endpointId, Math.max(1, opts.units ?? 1), opts.seconds);
    return est.costUSD ?? undefined;
  } catch {
    return undefined;
  }
}
