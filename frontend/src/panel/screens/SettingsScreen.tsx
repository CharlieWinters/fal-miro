import { useState } from 'react';
import {
  allCategories,
  allProviders,
  getActiveCatalogFilter,
  setActiveCatalogFilter,
  type CatalogFilter,
} from '../../shared/falCatalog';
import { setCatalogFilter } from '../../shared/storage';

/**
 * Curation settings: choose which categories and providers appear in Browse.
 * An empty selection in a section hides it entirely; selecting everything is
 * stored as "all" (null). Nothing is hidden by code — training et al. are just
 * unticked here by default once the synced catalog surfaces them.
 */
export function SettingsScreen() {
  const categories = allCategories();
  const providers = allProviders();
  const current = getActiveCatalogFilter();

  const [cats, setCats] = useState<Set<string>>(() => new Set(current.categories ?? categories));
  const [provs, setProvs] = useState<Set<string>>(() => new Set(current.providers ?? providers));
  const [note, setNote] = useState<string | null>(null);

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
    </div>
  );
}
