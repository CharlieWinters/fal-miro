import { useState } from 'react';
import { dismissJob, useActiveJobs, usePersistedJobs } from './jobs';
import { findModel, type Capability } from '../shared/falCatalog';
import { toneOf } from '../shared/capabilityTone';

/**
 * Shows in-flight generations so the user can fire several in parallel — and,
 * after a reopen, whatever's still in the durable queue (resuming in the
 * background). Live session jobs take precedence; persisted jobs already shown
 * live are de-duped by their Fal request id.
 *
 * Every row has a dismiss (✕) button — jobs that get stuck (a resumed poll
 * that keeps timing out) would otherwise sit here forever. Dismissing hides
 * the row immediately (optimistic — the persisted queue only reflects the
 * removal on its next poll) and best-effort cancels + cleans up in the
 * background (see `dismissJob`).
 */
export function ActiveJobsTray() {
  const live = useActiveJobs();
  const persisted = usePersistedJobs();
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const liveFalIds = new Set(live.map((j) => j.falRequestId).filter(Boolean) as string[]);
  const visibleLive = live.filter(
    (j) => !dismissed.has(j.requestId) && !(j.falRequestId && dismissed.has(j.falRequestId)),
  );
  const resuming = persisted.filter((p) => !liveFalIds.has(p.requestId) && !dismissed.has(p.requestId));

  if (visibleLive.length === 0 && resuming.length === 0) return null;

  const onDismiss = (localRequestId: string | undefined, falRequestId: string | undefined) => {
    setDismissed((s) => {
      const next = new Set(s);
      if (localRequestId) next.add(localRequestId);
      if (falRequestId) next.add(falRequestId);
      return next;
    });
    void dismissJob({ localRequestId, falRequestId });
  };

  return (
    <div className="tray">
      {visibleLive.map((j) => {
        // Tone the dot by capability while in flight; done/failed keep their
        // status colour (set in CSS, so don't override it inline).
        const toneStyle =
          j.status === 'succeeded' || j.status === 'failed'
            ? undefined
            : { background: toneOf(j.kind as Capability) };
        return (
          <div key={j.requestId} className={`tray-job ${j.status}`}>
            <span className="dot" style={toneStyle} />
            <span className="tray-label">{j.label}</span>
            <span className="tray-status">{j.error ?? j.message ?? j.status}</span>
            <button
              type="button"
              className="tray-dismiss"
              title="Cancel & remove"
              onClick={() => onDismiss(j.requestId, j.falRequestId)}
            >
              ✕
            </button>
          </div>
        );
      })}

      {resuming.map((j) => {
        const model = findModel(j.endpointId);
        const label = model?.label ?? j.endpointId.replace(/^fal-ai\//, '');
        return (
          <div key={j.requestId} className="tray-job running">
            <span className="dot" style={{ background: toneOf(model?.capability) }} />
            <span className="tray-label">{label}</span>
            <span className="tray-status">resuming…</span>
            <button
              type="button"
              className="tray-dismiss"
              title="Cancel & remove"
              onClick={() => onDismiss(undefined, j.requestId)}
            >
              ✕
            </button>
          </div>
        );
      })}
    </div>
  );
}
