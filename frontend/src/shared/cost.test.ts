// reportedInferenceSeconds reads a number out of whatever shape a given fal
// model happens to return. Different families use different keys, and some
// return nothing at all — a wrong answer here bills the user against the wrong
// number, so "no timing" must stay distinguishable from "zero seconds".

import { describe, it, expect } from 'vitest';
import { reportedInferenceSeconds } from './cost';

describe('reportedInferenceSeconds', () => {
  it('reads the common timings.inference shape', () => {
    expect(reportedInferenceSeconds({ timings: { inference: 23.7 } })).toBe(23.7);
  });

  it.each([
    ['timings', 'inference_time'],
    ['timing', 'total'],
    ['metrics', 'elapsed'],
    ['metrics', 'duration'],
  ])('reads %s.%s', (block, key) => {
    expect(reportedInferenceSeconds({ [block]: { [key]: 12 } })).toBe(12);
  });

  it('returns undefined when there is no timing block', () => {
    expect(reportedInferenceSeconds({ images: [] })).toBeUndefined();
  });

  it.each([null, undefined, 42, 'nope', []])('returns undefined for %p', (input) => {
    expect(reportedInferenceSeconds(input)).toBeUndefined();
  });

  it('treats a non-positive or non-numeric duration as absent', () => {
    // Zero would otherwise read as a real measurement and estimate a £0 job.
    expect(reportedInferenceSeconds({ timings: { inference: 0 } })).toBeUndefined();
    expect(reportedInferenceSeconds({ timings: { inference: -5 } })).toBeUndefined();
    expect(reportedInferenceSeconds({ timings: { inference: '23.7' } })).toBeUndefined();
    expect(reportedInferenceSeconds({ timings: { inference: null } })).toBeUndefined();
  });

  it('survives a timing block that is not an object', () => {
    expect(reportedInferenceSeconds({ timings: 'fast' })).toBeUndefined();
    expect(reportedInferenceSeconds({ timings: null })).toBeUndefined();
  });
});
