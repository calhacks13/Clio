import type { HandSample } from '@clio/protocol';
import type { Vec3 } from '../../src/core/math';
import type { CheckContext } from '../../src/domain/procedure/checks/types';

export interface CtxInput {
  t: number;
  stepStartT?: number;
  left?: HandSample | null;
  right?: HandSample | null;
  pinching?: { left?: boolean; right?: boolean };
  objects?: Record<string, Vec3>;
  confirmations?: { coach?: boolean; user?: boolean };
}

export function ctx(input: CtxInput): CheckContext {
  const objects = input.objects ?? {};
  return {
    t: input.t,
    stepStartT: input.stepStartT ?? 0,
    frame: {
      t: input.t,
      head: { p: [0, 0.5, 0.3], q: [0, 0, 0, 1] },
      left: input.left ?? null,
      right: input.right ?? null,
    },
    pinching: { left: input.pinching?.left ?? false, right: input.pinching?.right ?? false },
    objects: { position: (id) => objects[id] },
    confirmations: {
      coach: input.confirmations?.coach ?? false,
      user: input.confirmations?.user ?? false,
    },
  };
}
