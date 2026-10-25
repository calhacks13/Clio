import { type EnvironmentMesh, roomScanMediaName } from '@clio/protocol';
import { createLogger } from '../../core/log';
import type { Pose } from '../../core/math';
import type { AppBus } from '../events';
import { type GlbMeshNode, writeGlb } from '../recording/glb';
import { surfaceKindOf } from './environment';
import type { Workspace } from './workspace';

// The Quest room scan (Space Setup), read through WebXR mesh detection: the room's global mesh and
// a volume for each labelled piece of furniture (docs/room-scene.md). Meshes exist only inside an
// XR frame, so they are snapshotted while the episode records: one `environment.meshes` event and
// one GLB (media/room-scan-<n>.glb, every mesh in W) as soon as there are meshes, and again when
// one appears, disappears or changes, at most every 10 s and at most 8 times an episode. The
// global mesh can have tens of thousands of vertices, so between snapshots nothing is copied and
// the meshes are looked at only about once a second.

const log = createLogger('room-scan');

/** A mesh as the headset detected it, in world (local-floor) space. */
export interface DetectedMesh {
  /** Stable for the session; the reader numbers meshes as it first sees them ("mesh-1", ...). */
  key: string;
  /** The WebXR semanticLabel as reported ("global mesh" for the room's own). */
  label: string | null;
  /** Null while the runtime can't locate the mesh. */
  pose: Pose | null;
  /** xyz per vertex, meters in the mesh's frame: the XRMesh's own array, never modified. */
  vertices: Float32Array;
  /** Three per triangle. */
  indices: Uint32Array;
  /** When the runtime last changed the mesh (XRMesh.lastChangedTime, performance.now ms). */
  changedAt: number;
}

export interface RoomScanRecorderDeps {
  bus: AppBus;
  /** Uploads a snapshot's GLB with the episode (EpisodeRecorder.attachMedia). */
  attach: (name: string, glb: Blob) => void;
  /** Shortest time between two snapshots (ms, default 10 s); a change waits for it. */
  minIntervalMs?: number;
  /** Most snapshots per episode (default 8). */
  maxSnapshots?: number;
}

export const ROOM_SCAN_INTERVAL_MS = 10_000;
export const ROOM_SCAN_MAX_SNAPSHOTS = 8;
/** Once there is a snapshot, the meshes are looked at again this often for a change (ms). */
const CHECK_INTERVAL_MS = 1000;
/** A snapshot waits this long for every mesh to be located before it leaves the others out (ms). */
const LOCATE_WAIT_MS = 2000;
/** Most meshes in one snapshot (the event's schema). */
const MAX_MESHES = 512;
const GLOBAL_LABEL = 'global mesh';

/** Records room scan snapshots for one episode at a time; reset() at each episode start. */
export class RoomScanRecorder {
  private taken = 0;
  /** Keys, change times and located state of the last snapshot; null before the first. */
  private recorded: string | null = null;
  private takenT = Number.NEGATIVE_INFINITY;
  private checkedT = Number.NEGATIVE_INFINITY;
  /** Since when a snapshot has waited for an unlocated mesh, if it is waiting. */
  private waitingSince: number | null = null;

  constructor(private readonly deps: RoomScanRecorderDeps) {}

  /** Snapshots taken this episode. */
  get snapshots(): number {
    return this.taken;
  }

  /**
   * Whether update() could take a snapshot at `t`, so the caller reads the meshes only then:
   * every frame until the first snapshot, then about once a second once the interval is over.
   */
  wants(t: number): boolean {
    if (this.taken >= (this.deps.maxSnapshots ?? ROOM_SCAN_MAX_SNAPSHOTS)) return false;
    if (this.taken === 0) return true;
    const interval = this.deps.minIntervalMs ?? ROOM_SCAN_INTERVAL_MS;
    return t - this.takenT >= interval && t - this.checkedT >= CHECK_INTERVAL_MS;
  }

  /** While recording: the meshes detected now (world space) and the episode's W. */
  update(t: number, meshes: readonly DetectedMesh[], workspace: Workspace): void {
    if (!this.wants(t)) return;
    this.checkedT = t;
    // Nothing yet, or the runtime dropped every mesh: the last snapshot stays the room.
    if (meshes.length === 0) return;
    const signature = meshes
      .map((m) => `${m.key}@${m.changedAt}${m.pose ? '' : '?'}`)
      .sort()
      .join('|');
    if (signature === this.recorded) {
      this.waitingSince = null;
      return;
    }
    if (meshes.some((m) => !m.pose)) {
      this.waitingSince ??= t;
      if (t - this.waitingSince < LOCATE_WAIT_MS) return;
    }
    this.waitingSince = null;
    this.recorded = signature;
    this.snapshot(t, meshes, workspace);
  }

  /** Forget the episode's snapshots, so the next update records one (a new episode). */
  reset(): void {
    this.taken = 0;
    this.recorded = null;
    this.takenT = Number.NEGATIVE_INFINITY;
    this.checkedT = Number.NEGATIVE_INFINITY;
    this.waitingSince = null;
  }

  private snapshot(t: number, meshes: readonly DetectedMesh[], workspace: Workspace): void {
    const nodes: GlbMeshNode[] = [];
    const recorded: EnvironmentMesh[] = [];
    let invalid = 0;
    for (const mesh of meshes) {
      if (!mesh.pose) continue;
      if (!usable(mesh)) {
        invalid++;
        continue;
      }
      if (nodes.length >= MAX_MESHES) break;
      const kind = surfaceKindOf(mesh.label);
      const global = mesh.label?.toLowerCase() === GLOBAL_LABEL;
      const pose = workspace.toWorkspacePose(mesh.pose);
      nodes.push({
        name: mesh.key,
        translation: pose.p,
        rotation: pose.q,
        positions: mesh.vertices,
        indices: mesh.indices,
        extras: { kind, label: mesh.label, global },
      });
      recorded.push({
        id: mesh.key,
        kind,
        label: mesh.label,
        global,
        vertices: mesh.vertices.length / 3,
        triangles: Math.floor(mesh.indices.length / 3),
      });
    }
    if (invalid > 0) log.warn(`left out ${invalid} mesh(es) with unusable geometry`);
    if (nodes.length === 0) return;
    // The only copy of the geometry: into the GLB, once per snapshot.
    const glb = new Blob([writeGlb(nodes)], { type: 'model/gltf-binary' });
    this.taken++;
    this.takenT = t;
    const media = roomScanMediaName(this.taken);
    this.deps.bus.emit('environment.meshes', { t, media, meshes: recorded });
    this.deps.attach(media, glb);
  }
}

/**
 * Geometry a reader can take: whole vertices, all finite, and at least one triangle whose
 * indices all name a vertex. One pass over each array, only when a snapshot is taken.
 */
function usable(mesh: DetectedMesh): boolean {
  const { vertices, indices } = mesh;
  if (vertices.length < 9 || vertices.length % 3 !== 0 || indices.length < 3) return false;
  for (let i = 0; i < vertices.length; i++) {
    if (!Number.isFinite(vertices[i])) return false;
  }
  const count = vertices.length / 3;
  for (let i = 0; i < indices.length - (indices.length % 3); i++) {
    if ((indices[i] ?? count) >= count) return false;
  }
  return true;
}
