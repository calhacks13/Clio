import type { SurfaceKind } from '@clio/protocol';
import { type Pose, poseToTuple } from '../../core/math';
import type { AppBus } from '../events';
import type { Workspace } from './workspace';

// The room around the workspace, from WebXR plane detection (Quest's room setup: tables, the floor,
// walls). Planes exist only inside an XR frame, so they are snapshotted while the episode records:
// one `environment.planes` event with every plane in W at the start, and again whenever a plane
// appears, disappears or changes. The pipeline merges the snapshots into environment.json.

/** A plane as the headset detected it, in world (local-floor) space. */
export interface DetectedPlane {
  /** Stable for the session; the reader numbers planes as it first sees them ("plane-1", ...). */
  key: string;
  orientation: 'horizontal' | 'vertical';
  /** The WebXR semanticLabel as reported. */
  label: string | null;
  /** The polygon lies in its local x/z plane and +y is the normal. */
  pose: Pose;
  /** Outline in plane-local [x, z] meters. */
  polygon: (readonly [number, number])[];
  /** When the runtime last changed the plane (XRPlane.lastChangedTime, performance.now ms). */
  changedAt: number;
}

export interface EnvironmentRecorderDeps {
  bus: AppBus;
  /** Shortest time between two snapshots (ms, default 1000); a change waits for it. */
  minIntervalMs?: number;
}

/** Most planes in one snapshot, and most outline points per plane (EnvironmentPlaneSchema). */
const MAX_PLANES = 128;
const MAX_POINTS = 256;

// The WebXR semantic label registry, grouped as the tracking page colors it (tracking/palette.ts).
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

/** What a surface is, from its semantic label. */
export function surfaceKindOf(label: string | null | undefined): SurfaceKind {
  return (label && KIND_OF_LABEL[label.toLowerCase()]) || 'other';
}

/** At most MAX_POINTS points, evenly spaced along the outline. */
function decimate(polygon: DetectedPlane['polygon']): [number, number][] {
  const n = polygon.length;
  const keep = Math.min(n, MAX_POINTS);
  return Array.from({ length: keep }, (_, i) => {
    const [x, z] = polygon[Math.floor((i * n) / keep)] ?? [0, 0];
    return [x, z];
  });
}

/** Records plane snapshots for one episode at a time; reset() at each episode start. */
export class EnvironmentRecorder {
  /** Keys and change times of the last snapshot; null until the first one of the episode. */
  private recorded: string | null = null;
  private recordedT = Number.NEGATIVE_INFINITY;

  constructor(private readonly deps: EnvironmentRecorderDeps) {}

  /** Every XR frame while recording: the planes detected now (world space) and the episode's W. */
  update(t: number, planes: readonly DetectedPlane[], workspace: Workspace): void {
    const kept = planes
      .filter((p) => p.polygon.length >= 3 && p.polygon.every(([x, z]) => isFinite2(x, z)))
      .slice(0, MAX_PLANES);
    const signature = kept
      .map((p) => `${p.key}@${p.changedAt}`)
      .sort()
      .join('|');
    if (signature === this.recorded) return;
    const minInterval = this.deps.minIntervalMs ?? 1000;
    if (this.recorded !== null && t - this.recordedT < minInterval) return;
    this.recorded = signature;
    this.recordedT = t;
    this.deps.bus.emit('environment.planes', {
      t,
      planes: kept.map((p) => ({
        id: p.key,
        kind: surfaceKindOf(p.label),
        label: p.label,
        orientation: p.orientation,
        pose: poseToTuple(workspace.toWorkspacePose(p.pose)),
        polygon: decimate(p.polygon),
      })),
    });
  }

  /** Forget the last snapshot, so the next update records one (a new episode). */
  reset(): void {
    this.recorded = null;
    this.recordedT = Number.NEGATIVE_INFINITY;
  }
}

const isFinite2 = (x: number, z: number) => Number.isFinite(x) && Number.isFinite(z);
