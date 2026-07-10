import { useEffect, useState } from 'react';

/**
 * Subscribes to the board selection and returns the first item matching `type`
 * (e.g. 'sticky_note'). Re-emits whenever the selection changes.
 */
export function useFirstSelected<T = unknown>(
  type: 'sticky_note' | 'image' | 'embed',
): T | null {
  const [item, setItem] = useState<T | null>(null);

  useEffect(() => {
    let mounted = true;

    const apply = async () => {
      try {
        const sel = await miro.board.getSelection();
        const found = (sel as Array<{ type: string }>).find((s) => s.type === type) as T | undefined;
        if (mounted) setItem(found ?? null);
      } catch (e) {
        console.warn('[useFirstSelected] getSelection failed:', e);
      }
    };

    apply();

    const handler = (event: { items: Array<{ type: string }> }) => {
      const found = event.items.find((s) => s.type === type) as T | undefined;
      if (mounted) setItem(found ?? null);
    };

    miro.board.ui.on('selection:update', handler);
    return () => {
      mounted = false;
      try {
        miro.board.ui.off('selection:update', handler);
      } catch {
        /* older SDKs */
      }
    };
  }, [type]);

  return item;
}

/** Like useFirstSelected, but returns ALL selected items of the given type. */
export function useSelectedItems<T = unknown>(
  type: 'sticky_note' | 'image' | 'embed',
): T[] {
  const [items, setItems] = useState<T[]>([]);

  useEffect(() => {
    let mounted = true;

    const apply = async () => {
      try {
        const sel = await miro.board.getSelection();
        const found = (sel as Array<{ type: string }>).filter((s) => s.type === type) as T[];
        if (mounted) setItems(found);
      } catch (e) {
        console.warn('[useSelectedItems] getSelection failed:', e);
      }
    };

    apply();

    const handler = (event: { items: Array<{ type: string }> }) => {
      if (mounted) setItems(event.items.filter((s) => s.type === type) as T[]);
    };

    miro.board.ui.on('selection:update', handler);
    return () => {
      mounted = false;
      try {
        miro.board.ui.off('selection:update', handler);
      } catch {
        /* older SDKs */
      }
    };
  }, [type]);

  return items;
}
