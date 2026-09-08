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

type UnitPrice = { unitPrice: number; perSecond: boolean } | null;

// Fal's pricing endpoint rate-limits a burst of lookups (a run of a few
// generations in a row was enough to get a 429), and a failed lookup used to
// mean the item was stamped with no cost at all. Prices change rarely, so
// remember each endpoint's unit price for the session and retry once before
// giving up. Exposed for tests.
const unitPriceCache = new Map<string, Promise<UnitPrice>>();
export function resetCostCacheForTests(): void {
  unitPriceCache.clear();
}

async function fetchUnitPrice(endpointId: string): Promise<UnitPrice> {
  const est = await api.estimate(endpointId, 1);
  if (typeof est.unitPrice !== 'number') return null;
  return { unitPrice: est.unitPrice, perSecond: Boolean(est.perSecond) };
}

async function unitPriceFor(endpointId: string, sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))): Promise<UnitPrice> {
  const cached = unitPriceCache.get(endpointId);
  if (cached) return cached;
  const p = (async () => {
    try {
      return await fetchUnitPrice(endpointId);
    } catch {
      await sleep(1500);
      return fetchUnitPrice(endpointId);
    }
  })();
  unitPriceCache.set(endpointId, p);
  try {
    return await p;
  } catch (e) {
    unitPriceCache.delete(endpointId); // don't cache a failure
    throw e;
  }
}

/**
 * Best-effort cost in USD; undefined on any error. `seconds` (elapsed compute
 * time) is what time-billed models are charged on — pass it when Fal reported
 * one (see reportedInferenceSeconds); per-output models bill on `units`.
 */
export async function estimateCostUSD(
  endpointId: string,
  opts: { units?: number; seconds?: number } = {},
): Promise<number | undefined> {
  try {
    const price = await unitPriceFor(endpointId);
    if (!price) return undefined;
    const units = Math.max(1, opts.units ?? 1);
    const billed = price.perSecond && opts.seconds && opts.seconds > 0 ? opts.seconds : units;
    return Number((price.unitPrice * billed).toFixed(4));
  } catch {
    return undefined;
  }
}
