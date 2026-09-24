// H3 quantization, the single source of truth for turning a precise GPS fix into a coarse cell.
import { latLngToCell, cellToLatLng, isValidCell, getResolution, gridDisk } from 'h3-js';

export const H3_RES = 9 as const;

/** Precise GPS -> H3 res-9 cell id. Call this on-device; discard the raw fix. */
export function quantize(lat: number, lng: number): string {
  return latLngToCell(lat, lng, H3_RES);
}

/** Cell id -> its centre [lat, lng]. The server uses the CENTRE, never user GPS. */
export function cellCenter(cell: string): [number, number] {
  const [lat, lng] = cellToLatLng(cell);
  return [lat, lng];
}

/** Strict validation: must be a real cell AND exactly resolution 9. */
export function isValidR9(cell: string): boolean {
  try {
    return isValidCell(cell) && getResolution(cell) === H3_RES;
  } catch {
    return false;
  }
}

/** Ring of neighbouring cells (k=1 => 7 cells), used to soften cell-edge jitter. */
export function neighbors(cell: string, k = 1): string[] {
  return gridDisk(cell, k);
}
