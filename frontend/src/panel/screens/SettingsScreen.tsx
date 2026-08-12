import { useEffect, useState } from 'react';
import {
  allCategories,
  allProviders,
  getActiveCatalogFilter,
  setActiveCatalogFilter,
  type CatalogFilter,
} from '../../shared/falCatalog';
import { setCatalogFilter } from '../../shared/storage';
import { getBackendConfig, setBackendConfig } from '../../shared/backendConfig';
import { api, configureBackend, miroConnectUrl } from '../../lib/api';

type SettingsScreenProps = {
  /** True when no backend is configured yet — shows only the backend section
   *  (no catalog curation, nothing to "go back" to) until it's saved. */
  forceBackendSetup?: boolean;
  /** Fired after a successful backend save, so the app can leave setup mode. */
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

  const [backendUrlInput, setBackendUrlInput] = useState(() => getBackendConfig()?.url ?? '');
  const [backendKeyInput, setBackendKeyInput] = useState(() => getBackendConfig()?.key ?? '');
  const [backendNote, setBackendNote] = useState<string | null>(null);
  const [miroNote, setMiroNote] = useState<string | null>(null);
  const [miroStatus, setMiroStatus] = useState<'checking' | 'connected' | 'not-connected' | 'error'>('checking');

  const checkMiroStatus = async () => {
    setMiroStatus('checking');
    try {
      const { id } = await miro.board.getUserInfo();
      const { connected } = await api.getMiroStatus(id);
      setMiroStatus(connected ? 'connected' : 'not-connected');
    } catch {
      setMiroStatus('error');
    }
  };

  useEffect(() => {
    if (!forceBackendSetup) void checkMiroStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forceBackendSetup]);

  const saveBackend = () => {
    const url = backendUrlInput.trim().replace(/\/+$/, '');
    const key = backendKeyInput.trim();
    if (!/^https?:\/\//.test(url)) {
      setBackendNote('Backend URL must start with http:// or https://');
      return;
    }
    if (!key) {
      setBackendNote('Backend key is required.');
      return;
    }
    setBackendConfig({ url, key });
    configureBackend({ url, key });
    setBackendNote('Saved.');
    onBackendConfigured?.();
  };

  // Opens Miro's OAuth consent screen in a new tab — needed only for reading
  // Doc-format item content (the Web SDK can't do that itself). There's no
  // real callback signal from that tab back into this one, so this just
  // polls the status endpoint a few times after opening it — good enough to
  // catch "approved and came back" without the user having to manually hit
  // a refresh button.
  const connectMiro = async () => {
    setMiroNote(null);
    try {
      const { id } = await miro.board.getUserInfo();
      window.open(miroConnectUrl(id), '_blank');
      setMiroNote('Opened Miro’s connect screen in a new tab — come back here once you’ve approved it.');
      for (const delayMs of [3000, 3000, 4000, 5000]) {
        await new Promise((r) => setTimeout(r, delayMs));
        const { connected } = await api.getMiroStatus(id);
        setMiroStatus(connected ? 'connected' : 'not-connected');
        if (connected) break;
      }
    } catch (e) {
      setMiroNote(e instanceof Error ? e.message : 'Failed to start the Miro connection.');
    }
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
        <div className="title">{forceBackendSetup ? 'Connect your backend' : 'Backend connection'}</div>
        <div className="sub">
          {forceBackendSetup
            ? 'No backend configured in this browser yet. Deploy your own (see the README’s ' +
              '"Deploy your own backend" section) and paste its URL + key below.'
            : 'The backend proxy you talk to — saved in this browser only. Other people on this ' +
              'board may be using a different backend of their own; that’s expected.'}
        </div>
      </div>

      <label className="field">
        <span>Backend URL</span>
        <input
          type="url"
          placeholder="https://your-backend.example.com"
          value={backendUrlInput}
          onChange={(e) => {
            setBackendUrlInput(e.target.value);
            setBackendNote(null);
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
            setBackendNote(null);
          }}
        />
      </label>
      <div style={{ display: 'flex', gap: 12 }}>
        <button type="button" className="primary" onClick={saveBackend}>
          Save backend
        </button>
      </div>
      {backendNote && <div className="notice">{backendNote}</div>}

      {!forceBackendSetup && (
        <>
          <div className="hero">
            <div className="title">Miro account</div>
            <div className="sub">
              Optional — connect your Miro account so the panel can read the text content of Doc
              items on the board (e.g. as a prompt source), which isn’t something the board plugin
              API can do on its own.
            </div>
          </div>
          <div className="ref-hint">
            {miroStatus === 'checking' && 'Checking connection…'}
            {miroStatus === 'connected' && (
              <>
                <span className="check">✓</span> Connected
              </>
            )}
            {miroStatus === 'not-connected' && 'Not connected.'}
            {miroStatus === 'error' && 'Couldn’t check status — is the backend reachable?'}
          </div>
          <div style={{ display: 'flex', gap: 12 }}>
            <button type="button" className="secondary" onClick={() => void connectMiro()}>
              {miroStatus === 'connected' ? 'Reconnect Miro account' : 'Connect Miro account'}
            </button>
            <button type="button" className="reset-link" onClick={() => void checkMiroStatus()}>
              Check status
            </button>
          </div>
          {miroNote && <div className="notice">{miroNote}</div>}

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
