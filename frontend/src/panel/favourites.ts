import { getFavouriteKeys, toggleFavouriteState } from '../shared/falCatalog';
import { setFavourites } from '../shared/storage';

/** Toggle a family's favourite (updates the live catalog + persists to the board). */
export function toggleFavourite(key: string): void {
  toggleFavouriteState(key);
  void setFavourites(getFavouriteKeys());
}
