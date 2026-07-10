import { useActiveJobs, usePersistedJobs } from './jobs';
import { findModel, type Capability } from '../shared/falCatalog';
import { toneOf } from '../shared/capabilityTone';

/**
 * Shows in-flight generations so the user can fire several in parallel — and,
 * after a reopen, whatever's still in the durable queue (resuming in the
 * background). Live session jobs take precedence; persisted jobs already shown
 * live are de-duped by their Fal request id.
 */
export function ActiveJobsTray() {
  const live = useActiveJobs();
  const persisted = usePersistedJobs();

  const liveFalIds = new Set(live.map((j) => j.falRequestId).filter(Boolean) as string[]);
  const resuming = persisted.filter((p) => !liveFalIds.has(p.requestId));

  if (live.length === 0 && resuming.length === 0) return null;

  return (
    <div className="tray">
      {live.map((j) => {
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
          </div>
        );
      })}
    </div>
  );
}
