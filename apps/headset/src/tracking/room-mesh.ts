import { BufferAttribute, BufferGeometry, Group, Mesh, MeshBasicMaterial } from 'three';
import { GLOBAL_MESH_COLOR, SURFACE_COLORS, type SurfaceKind, surfaceKind } from './palette';

// Every detected mesh (frame.detectedMeshes: furniture volumes and the room's global mesh) as a
// thin wireframe colored by semantic label. Same lifecycle as the planes: rebuilt when its
// lastChangedTime moves, posed every frame, dropped when it leaves the frame's set.

interface MeshVisual {
  readonly mesh: Mesh;
  changed: number;
  seen: number;
}

export class RoomMeshView {
  readonly object = new Group();
  /** False when the session has no mesh detection. */
  enabled = true;
  private readonly visuals = new Map<XRMesh, MeshVisual>();
  private readonly materials = Object.fromEntries(
    (Object.keys(SURFACE_COLORS) as SurfaceKind[]).map((kind) => [
      kind,
      new MeshBasicMaterial({ color: SURFACE_COLORS[kind], wireframe: true }),
    ]),
  ) as Record<SurfaceKind, MeshBasicMaterial>;
  private readonly globalMaterial = new MeshBasicMaterial({
    color: GLOBAL_MESH_COLOR,
    wireframe: true,
  });
  private stamp = 0;
  private frame: XRFrame | null = null;
  private space: XRReferenceSpace | null = null;

  get count(): number {
    return this.visuals.size;
  }

  update(frame: XRFrame, space: XRReferenceSpace): void {
    let meshes: XRMeshSet | undefined;
    try {
      meshes = this.enabled ? frame.detectedMeshes : undefined;
    } catch {
      this.enabled = false;
    }
    this.stamp++;
    this.frame = frame;
    this.space = space;
    meshes?.forEach(this.track);
    this.visuals.forEach(this.sweep);
    this.frame = null;
  }

  clear(): void {
    this.stamp++;
    this.visuals.forEach(this.sweep);
  }

  private readonly track = (xrMesh: XRMesh): void => {
    let visual = this.visuals.get(xrMesh);
    if (!visual) {
      const mesh = new Mesh(new BufferGeometry(), this.materials.other);
      mesh.matrixAutoUpdate = false;
      mesh.frustumCulled = false;
      this.object.add(mesh);
      visual = { mesh, changed: Number.NaN, seen: 0 };
      this.visuals.set(xrMesh, visual);
    }
    visual.seen = this.stamp;
    if (visual.changed !== xrMesh.lastChangedTime) {
      visual.changed = xrMesh.lastChangedTime;
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(xrMesh.vertices, 3));
      geometry.setIndex(new BufferAttribute(xrMesh.indices, 1));
      visual.mesh.geometry.dispose();
      visual.mesh.geometry = geometry;
      visual.mesh.material =
        xrMesh.semanticLabel === 'global mesh'
          ? this.globalMaterial
          : this.materials[surfaceKind(xrMesh.semanticLabel)];
    }
    const pose = this.frame && this.space && this.frame.getPose(xrMesh.meshSpace, this.space);
    visual.mesh.visible = Boolean(pose);
    if (!pose) return;
    visual.mesh.matrix.fromArray(pose.transform.matrix);
    visual.mesh.matrixWorldNeedsUpdate = true;
  };

  private readonly sweep = (visual: MeshVisual, xrMesh: XRMesh): void => {
    if (visual.seen === this.stamp) return;
    visual.mesh.geometry.dispose();
    this.object.remove(visual.mesh);
    this.visuals.delete(xrMesh);
  };
}
