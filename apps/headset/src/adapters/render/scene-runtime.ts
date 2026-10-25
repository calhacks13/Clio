import {
  DirectionalLight,
  Group,
  HemisphereLight,
  PerspectiveCamera,
  Quaternion,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { Pose } from '../../core/math';
import { frameGuard, installFrameDebug } from './frame-guard';

/**
 * The three.js side of the app. Two roots: `workspaceRoot` follows the calibrated workspace pose,
 * so presenters that place things on the table work directly in workspace coordinates (the same
 * frame as the data); `worldRoot` holds UI anchored in the room.
 */
export class SceneRuntime {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(70, 1, 0.01, 50);
  readonly workspaceRoot = new Group();
  readonly worldRoot = new Group();
  private readonly onResize = () => this.resize();

  constructor(container: HTMLElement) {
    this.renderer = new WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.xr.enabled = true;
    container.append(this.renderer.domElement);

    this.scene.add(new HemisphereLight(0xffffff, 0x444466, 1.2));
    const sun = new DirectionalLight(0xffffff, 1.0);
    sun.position.set(0.5, 2, 1);
    this.scene.add(sun);

    this.workspaceRoot.matrixAutoUpdate = false;
    this.workspaceRoot.name = 'workspace';
    this.worldRoot.name = 'world';
    this.scene.add(this.workspaceRoot, this.worldRoot);

    this.camera.position.set(0, 1.6, 0.6);
    this.resize();
    window.addEventListener('resize', this.onResize);
  }

  setWorkspacePose(pose: Pose): void {
    this.workspaceRoot.matrix.compose(
      new Vector3(...pose.p),
      new Quaternion(...pose.q),
      new Vector3(1, 1, 1),
    );
    this.workspaceRoot.matrixWorldNeedsUpdate = true;
  }

  /**
   * Runs `tick` every frame (XR frames once a session starts), then renders, each guarded
   * (frame-guard.ts): a step that throws costs that frame, never the loop.
   */
  start(tick: (time: number, frame: XRFrame | undefined) => void): void {
    installFrameDebug();
    this.renderer.setAnimationLoop(
      frameGuard.loop(tick, () => this.renderer.render(this.scene, this.camera)),
    );
  }

  stop(): void {
    this.renderer.setAnimationLoop(null);
    window.removeEventListener('resize', this.onResize);
  }

  private resize(): void {
    const { innerWidth: w, innerHeight: h } = window;
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }
}
