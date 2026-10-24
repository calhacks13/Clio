import type { Pose, Quat, Vec3 } from '../core/math';
import type { CameraIntrinsics } from '../domain/world/camera-model';
import { projectToUv } from './solver';

// Desktop runs of calibrate.html (?emulate=1): the IWER Quest 3 emulator (as in
// adapters/xr/emulator.ts, but keeping the device so the right hand can be moved) and a simulated
// passthrough camera. The simulated camera "sees" the right index fingertip and the placed marks
// as white dots where a hidden true camera (pose and focal length) would see them, so a full run
// can be driven from the console and the solver should recover that hidden camera.

export interface EmulatedHands {
  pinch(hand: 'left' | 'right', value?: number): void;
  /**
   * Moves the right index tip by `delta` (m, world). `tip` is where it is now: the first move
   * starts from there, later ones from the previous target (the pin holds it against DevUI).
   */
  nudgeRightTip(delta: Readonly<Vec3>, tip: Readonly<Vec3>): void;
  /** Turns the emulated headset to `q` (world). */
  turnHead(q: Readonly<Quat>): void;
}

export async function installCalibrationEmulator(): Promise<EmulatedHands> {
  const [{ XRDevice, metaQuest3 }, { DevUI }, { SyntheticEnvironmentModule }] = await Promise.all([
    import('iwer'),
    import('@iwer/devui'),
    import('@iwer/sem'),
  ]);
  const device = new XRDevice(metaQuest3);
  device.primaryInputMode = 'hand';
  device.installRuntime({ forceInstall: true });
  device.installDevUI(DevUI);
  device.installSEM(SyntheticEnvironmentModule);
  try {
    await device.sem?.loadDefaultEnvironment('sunlit_living_room');
  } catch {
    // An empty room is fine for calibration.
  }
  return {
    pinch: (hand, value = 1) => device.hands[hand]?.updatePinchValue(value),
    nudgeRightTip(delta, tip) {
      const hand = device.hands.right;
      if (!hand) return;
      const from = hand.pin?.target ?? tip;
      const target: [number, number, number] = [
        (from[0] ?? 0) + delta[0],
        (from[1] ?? 0) + delta[1],
        (from[2] ?? 0) + delta[2],
      ];
      hand.setPin({ anchor: 'index-tip', target });
    },
    turnHead(q) {
      device.quaternion.set(q[0], q[1], q[2], q[3]);
      // DevUI copies its own camera rig onto the device every frame; move the rig too.
      const ui = device.devui as unknown as { inputLayer?: { syncFromDevice?: () => void } };
      ui?.inputLayer?.syncFromDevice?.();
    },
  };
}

/** A stand-in camera feed: a dark frame with points drawn where the true camera would see them. */
export class SimulatedCamera {
  readonly canvas = document.createElement('canvas');
  private readonly g: CanvasRenderingContext2D | null;

  constructor(
    readonly intrinsics: CameraIntrinsics,
    readonly truth: Pose,
  ) {
    this.canvas.width = 640;
    this.canvas.height = Math.round((640 * intrinsics.height) / intrinsics.width);
    this.g = this.canvas.getContext('2d');
  }

  /** Redraws the frame with `points` (head frame): the fingertip and the marks. */
  update(points: readonly Readonly<Vec3>[]): void {
    const g = this.g;
    if (!g) return;
    const { width: w, height: h } = this.canvas;
    g.fillStyle = '#1b232c';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#26313c';
    for (let x = 0; x < w; x += 64) g.fillRect(x, 0, 1, h);
    for (let y = 0; y < h; y += 64) g.fillRect(0, y, w, 1);
    g.fillStyle = '#f2f5f7';
    for (const point of points) {
      const uv = projectToUv(this.intrinsics, this.truth, point);
      if (!uv) continue;
      g.beginPath();
      g.arc(uv[0] * w, uv[1] * h, 9, 0, Math.PI * 2);
      g.fill();
    }
  }
}
