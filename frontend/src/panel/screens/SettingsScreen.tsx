import { useState } from 'react';
import {
  allCategories,
  allProviders,
  getActiveCatalogFilter,
  setActiveCatalogFilter,
  type CatalogFilter,
} from '../../shared/falCatalog';
import { setCatalogFilter } from '../../shared/storage';
import { getConnectionConfig, setConnectionConfig } from '../../shared/backendConfig';
import { configureConnection, type ConnectionConfig } from '../../lib/api';

type SettingsScreenProps = {
  /** True when no backend is configured yet — shows only the connection section
   *  (no catalog curation, nothing to "go back" to) until it's saved. */
  forceBackendSetup?: boolean;
  /** Fired after a successful save, so the app can leave setup mode. */
  onBackendConfigured?: () => void;
};

/**
 * Curation settings: choose which categories and providers appear in Browse.
 * An empty selection in a section hides it entirely; selecting everything is
 * stored as "all" (null). Nothing is hidden by code — training et al. are just
 * unticked here by default once the synced catalog surfaces them.
 */
export function SettingsScreen({ forceBackendSetup, onBackendConfigured }: SettingsScreenProps) {
  const categories = allCategories();
  const providers = allProviders();
  const current = getActiveCatalogFilter();

  const [cats, setCats] = useState<Set<string>>(() => new Set(current.categories ?? categories));
  const [provs, setProvs] = useState<Set<string>>(() => new Set(current.providers ?? providers));
  const [note, setNote] = useState<string | null>(null);

  const savedConnection = getConnectionConfig();
  // Backend mode is the recommended default for a fresh install — full
  // feature set, and a browser-held key is the tradeoff-laden option, not
  // the path of least resistance.
  const [mode, setMode] = useState<'backend' | 'client'>(savedConnection?.mode ?? 'backend');
  const [backendUrlInput, setBackendUrlInput] = useState(
    () => (savedConnection?.mode === 'backend' ? savedConnection.url : '') ?? '',
  );
  const [backendKeyInput, setBackendKeyInput] = useState(
    () => (savedConnection?.mode === 'backend' ? savedConnection.key : '') ?? '',
  );
  const [falKeyInput, setFalKeyInput] = useState(
    () => (savedConnection?.mode === 'client' ? savedConnection.falKey : '') ?? '',
  );
  const [connectionNote, setConnectionNote] = useState<string | null>(null);

  const saveConnection = () => {
    let cfg: ConnectionConfig;
    if (mode === 'backend') {
      const url = backendUrlInput.trim().replace(/\/+$/, '');
      const key = backendKeyInput.trim();
      if (!/^https?:\/\//.test(url)) {
        setConnectionNote('Backend URL must start with http:// or https://');
        return;
      }
      if (!key) {
        setConnectionNote('Backend key is required.');
        return;
      }
      cfg = { mode: 'backend', url, key };
    } else {
      const key = falKeyInput.trim();
      if (!key) {
        setConnectionNote('Fal API key is required.');
        return;
      }
      cfg = { mode: 'client', falKey: key };
    }
    setConnectionConfig(cfg);
    configureConnection(cfg);
    setConnectionNote('Saved.');
    onBackendConfigured?.();
  };

  const toggle = (set: Set<string>, setSet: (s: Set<string>) => void, v: string) => {
    const next = new Set(set);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    setSet(next);
    setNote(null);
  };

  const save = async () => {
    const filter: CatalogFilter = {
      categories: cats.size === categories.length ? null : [...cats],
      providers: provs.size === providers.length ? null : [...provs],
    };
    setActiveCatalogFilter(filter); // live-updates Browse immediately
    try {
      await setCatalogFilter(filter);
      setNote('Saved.');
    } catch {
      setNote('Applied for this session (couldn’t persist to the board).');
    }
  };

  const resetAll = () => {
    setCats(new Set(categories));
    setProvs(new Set(providers));
    setNote(null);
  };

  return (
    <div className="screen">
      <div className="hero">
        <div className="title">Connection</div>
        <div className="sub">
          How this panel reaches Fal. Saved in this browser only — other people on this board may
          be connected their own way.
        </div>
      </div>

      <div className="conn-mode">
        <button
          type="button"
          className={`conn-card ${mode === 'client' ? 'selected' : ''}`}
          onClick={() => {
            setMode('client');
            setConnectionNote(null);
          }}
        >
          <span className="conn-radio">{mode === 'client' && <span className="conn-radio-dot" />}</span>
          <span className="conn-card-text">
            <span className="conn-card-title">Use your Fal key in this browser</span>
            <span className="conn-card-sub">
              Nothing to deploy. The key is stored here, so it's only as private as this browser.
            </span>
          </span>
        </button>
        <button
          type="button"
          className={`conn-card ${mode === 'backend' ? 'selected' : ''}`}
          onClick={() => {
            setMode('backend');
            setConnectionNote(null);
          }}
        >
          <span className="conn-radio">{mode === 'backend' && <span className="conn-radio-dot" />}</span>
          <span className="conn-card-text">
            <span className="conn-card-title">Deploy your own backend</span>
            <span className="conn-card-sub">Your Fal key lives on a server you control. Full feature set.</span>
          </span>
        </button>
      </div>

      {mode === 'backend' ? (
        <>
          <label className="field">
            <span>Backend URL</span>
            <input
              type="url"
              placeholder="https://your-backend.example.com"
              value={backendUrlInput}
              onChange={(e) => {
                setBackendUrlInput(e.target.value);
                setConnectionNote(null);
              }}
            />
          </label>
          <label className="field">
            <span>Backend key</span>
            <input
              type="password"
              placeholder="Matches BACKEND_KEY on your backend"
              value={backendKeyInput}
              onChange={(e) => {
                setBackendKeyInput(e.target.value);
                setConnectionNote(null);
              }}
            />
          </label>
          <div style={{ display: 'flex', gap: 12 }}>
            <button type="button" className="primary" onClick={saveConnection}>
              Save backend
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="key-info">
            <span className="key-info-title">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <rect x="3" y="11" width="18" height="10" rx="2" />
                <path d="M8 11V7a4 4 0 0 1 8 0v4" />
              </svg>
              Where the key lives
            </span>
            <span className="key-info-body">
              Saved in this browser and sent straight to fal.ai. Anything with access to this
              browser — devtools, an extension, someone using your machine — can read it, and it
              isn't scoped or spend-limited the way a backend key is.
            </span>
            <span className="key-info-body muted">
              Fine for solo use on your own device. On a shared or team machine, deploy a backend
              instead.
            </span>
          </div>
          <label className="field">
            <span>Fal API key</span>
            <input
              type="password"
              placeholder="fal-…"
              value={falKeyInput}
              onChange={(e) => {
                setFalKeyInput(e.target.value);
                setConnectionNote(null);
              }}
            />
          </label>
          <span className="key-info-hint">
            Create one at fal.ai/dashboard/keys. Stored in this browser only — never sent to Miro.
          </span>
          <div style={{ display: 'flex', gap: 12 }}>
            <button type="button" className="primary" onClick={saveConnection}>
              Save key
            </button>
          </div>
        </>
      )}
      {connectionNote && <div className="notice">{connectionNote}</div>}

      {!forceBackendSetup && (
        <>
          <div className="hero">
            <div className="title">Curate models</div>
            <div className="sub">Choose what shows in Browse. Applies to Category & Provider.</div>
          </div>

          <span className="label">Categories</span>
          <div className="schema-form">
            {categories.map((c) => (
              <label key={c} className="field-row">
                <input type="checkbox" checked={cats.has(c)} onChange={() => toggle(cats, setCats, c)} />
                <span>{c}</span>
              </label>
            ))}
          </div>

          <span className="label">Providers</span>
          <div className="schema-form">
            {providers.map((p) => (
              <label key={p} className="field-row">
                <input type="checkbox" checked={provs.has(p)} onChange={() => toggle(provs, setProvs, p)} />
                <span>{p}</span>
              </label>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 12 }}>
            <button type="button" className="primary" onClick={() => void save()}>
              Save
            </button>
            <button type="button" className="reset-link" onClick={resetAll}>
              Select all
            </button>
          </div>

          {note && <div className="notice">{note}</div>}
        </>
      )}
    </div>
  );
}
