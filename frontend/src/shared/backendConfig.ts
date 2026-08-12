// The backend URL + shared secret live in this browser's localStorage — not
// board appData. This is deliberately per-person, not per-board: different
// people collaborating on the very same board may each be running their own
// self-hosted backend (own FAL_KEY), so a board-level setting would wrongly
// force them to share one. Each of the three iframes (headless, panel, modal)
// loads this once at startup — see headless/index.ts, panel/App.tsx,
// modal/App.tsx — before doing anything that talks to the backend.
import { configureBackend, type BackendConfig } from '../lib/api';

const STORAGE_KEY = 'fal:backendConfig';

export function getBackendConfig(): BackendConfig | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.url === 'string' && typeof parsed.key === 'string') {
      return parsed as BackendConfig;
    }
  } catch (e) {
    console.warn('[backendConfig] failed to read localStorage:', e);
  }
  return null;
}

export function setBackendConfig(cfg: BackendConfig): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
}

/** Loads this browser's backend config into api.ts. Returns whether one was set. */
export function loadBackendConfig(): boolean {
  const cfg = getBackendConfig();
  configureBackend(cfg);
  return Boolean(cfg?.url && cfg?.key);
}

/**
 * Notifies `onChange` whenever another same-origin browsing context changes
 * the backend config in localStorage. The headless iframe needs this: it
 * loads the config once at boot and then runs independently of the panel
 * (dispatching /api/fal/run, polling resume_jobs, …), so without this it
 * would keep using a stale backend after the user edits Settings until the
 * whole board reloads. The `storage` event only fires in *other* browsing
 * contexts than the one that made the change (never the panel that just
 * saved it), which is exactly the gap this needs to fill.
 *
 * Returns an unsubscribe function.
 */
export function watchBackendConfig(onChange: (configured: boolean) => void): () => void {
  const handler = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY || e.key === null) {
      onChange(loadBackendConfig());
    }
  };
  window.addEventListener('storage', handler);
  return () => window.removeEventListener('storage', handler);
}
