import { createLogger } from '../../core/log';

// Desktop development without a headset: IWER (Meta's Immersive Web Emulation Runtime) installs an
// emulated Quest 3 behind navigator.xr, with hand tracking, a synthetic room (planes, meshes,
// hit-test) and an on-screen control panel. Loaded only on demand, never on the headset.

const log = createLogger('emulator');

export interface EmulatorHandle {
  /** Pinch (1) or release (0) an emulated hand, e.g. from the console: clio.pinch('right'). */
  pinch(hand: 'left' | 'right', value?: number): void;
}

export async function installEmulator(room = 'sunlit_living_room'): Promise<EmulatorHandle> {
  const [{ XRDevice, metaQuest3 }, { DevUI }, { SyntheticEnvironmentModule }] = await Promise.all([
    import('iwer'),
    import('@iwer/devui'),
    import('@iwer/sem'),
  ]);
  const device = new XRDevice(metaQuest3);
  // Chrome ships a native navigator.xr; force the emulated runtime over it.
  device.installRuntime({ forceInstall: true });
  device.installDevUI(DevUI);
  device.installSEM(SyntheticEnvironmentModule);
  try {
    await device.sem?.loadDefaultEnvironment(room);
  } catch (err) {
    log.warn(`synthetic room "${room}" failed to load: ${String(err)}`);
  }
  device.primaryInputMode = 'hand';
  log.info('IWER Quest 3 emulator installed (hand input)');
  return {
    pinch: (hand, value = 1) => device.hands[hand]?.updatePinchValue(value),
  };
}
