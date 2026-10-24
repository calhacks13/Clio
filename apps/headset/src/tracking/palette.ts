// Colors for the tracking page. Surfaces are grouped by semantic label (Quest's Space Setup and
// IWER's synthetic rooms use the WebXR semantic label registry), so a room reads at a glance.

export type SurfaceKind = 'table' | 'floor' | 'wall' | 'ceiling' | 'couch' | 'other';

const KIND_OF_LABEL: Record<string, SurfaceKind> = {
  table: 'table',
  desk: 'table',
  floor: 'floor',
  wall: 'wall',
  door: 'wall',
  'door frame': 'wall',
  window: 'wall',
  'window frame': 'wall',
  'wall art': 'wall',
  'invisible wall face': 'wall',
  ceiling: 'ceiling',
  couch: 'couch',
};

export function surfaceKind(label: string | undefined): SurfaceKind {
  return (label && KIND_OF_LABEL[label.toLowerCase()]) || 'other';
}

export const SURFACE_COLORS: Record<SurfaceKind, number> = {
  table: 0xffb347,
  floor: 0x5ad18a,
  wall: 0x6aa8ff,
  ceiling: 0xc58cff,
  couch: 0xe08a5a,
  other: 0xa8b3bd,
};

/** The room's whole scanned mesh is dense; drawn dim, so the furniture volumes stand out. */
export const GLOBAL_MESH_COLOR = 0x4a5560;

export const HAND_COLORS = { left: 0x4fe3ff, right: 0xff6fd8 } as const;

/** Shown above a plane: its semantic label as reported, capitalized. */
export function surfaceTitle(label: string | undefined): string {
  const text = label?.trim() || 'other';
  return text.charAt(0).toUpperCase() + text.slice(1);
}
