import { useEffect, useState } from 'react';
import { isCatalogReady, subscribeCatalog } from '../../shared/falCatalog';

/** Re-render the caller whenever the curation filter (active catalog) changes. */
export function useCatalogVersion(): void {
  const [, force] = useState(0);
  useEffect(() => subscribeCatalog(() => force((v) => v + 1)), []);
}

/** Whether the catalog sync has settled (cache applied or first sync done). */
export function useCatalogReady(): boolean {
  const [ready, setReady] = useState(isCatalogReady);
  useEffect(() => subscribeCatalog(() => setReady(isCatalogReady())), []);
  return ready;
}
