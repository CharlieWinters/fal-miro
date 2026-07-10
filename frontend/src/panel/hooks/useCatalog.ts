import { useEffect, useState } from 'react';
import { subscribeCatalog } from '../../shared/falCatalog';

/** Re-render the caller whenever the curation filter (active catalog) changes. */
export function useCatalogVersion(): void {
  const [, force] = useState(0);
  useEffect(() => subscribeCatalog(() => force((v) => v + 1)), []);
}
