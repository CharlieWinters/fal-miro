import { useEffect, useState } from 'react';
import { getItemGenerationSettings } from '../shared/storage';
import type { GenSettings } from '../shared/storage';

type SelItem = { id: string };

/**
 * Tools that act on the current board selection: roll up the estimated cost of
 * selected generated assets, and trace an asset's lineage through item metadata.
 */
export function SelectionTools() {
  const [items, setItems] = useState<SelItem[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [lineage, setLineage] = useState<string[] | null>(null);

  useEffect(() => {
    let mounted = true;
    // Takes the selection as an argument so the event path can pass
    // `event.items` straight in — re-calling getSelection() on every click
    // was one metered read per click for data the event already carried.
    const apply = async (sel: Array<{ id: string }>) => {
      if (!mounted) return;
      setItems(sel.map((s) => ({ id: s.id })));
      setLineage(null);
      let sum = 0;
      let found = false;
      for (const s of sel) {
        const g = await getItemGenerationSettings<GenSettings>(s.id);
        if (g?.costUSD != null) {
          sum += g.costUSD;
          found = true;
        }
      }
      if (mounted) setTotal(found ? sum : null);
    };
    void miro.board
      .getSelection()
      .then((sel) => apply(sel as Array<{ id: string }>))
      .catch((e) => console.warn('[SelectionTools] initial getSelection failed:', e));
    const handler = (event: { items: Array<{ id: string }> }) => void apply(event.items);
    miro.board.ui.on('selection:update', handler);
    return () => {
      mounted = false;
      try {
        miro.board.ui.off('selection:update', handler);
      } catch {
        /* older SDKs */
      }
    };
  }, []);

  const trace = async () => {
    if (items.length === 0) return;
    const lines: string[] = [];
    const seen = new Set<string>();
    const walk = async (id: string, depth: number) => {
      const indent = '  '.repeat(depth);
      if (seen.has(id)) {
        lines.push(`${indent}↩ (already shown)`);
        return;
      }
      seen.add(id);
      const g = await getItemGenerationSettings<GenSettings>(id);
      const label = g?.endpointId
        ? `${g.endpointId.replace(/^fal-ai\//, '')}${g.costUSD != null ? ` ($${g.costUSD.toFixed(3)})` : ''}`
        : 'source asset';
      lines.push(`${indent}• ${label}`);
      for (const p of g?.parents ?? []) await walk(p, depth + 1);
    };
    await walk(items[0].id, 0);
    setLineage(lines);
  };

  if (items.length === 0) return null;

  return (
    <div className="selection-tools">
      <div className="st-head">
        {items.length} selected{total != null ? ` · est. $${total.toFixed(2)}` : ''}
      </div>
      <button type="button" className="reset-link" onClick={trace}>
        Trace lineage of first item
      </button>
      {lineage && <pre className="lineage">{lineage.join('\n')}</pre>}
    </div>
  );
}
