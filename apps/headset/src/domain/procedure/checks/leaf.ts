import type {
  ConfirmCheck,
  ElapsedCheck,
  Handedness,
  HandNearCheck,
  HandSample,
  HandSelector,
  LiftCheck,
  ObjectNearCheck,
  PinchNearCheck,
} from '@clio/protocol';
import { distance } from '../../../core/math';
import { handPoint, pinchPoint } from '../../hands/features';
import { handOf } from '../../hands/types';
import { DwellGate } from './dwell';
import type { CheckContext, CheckEvaluator, CheckStatus } from './types';

const handsFor = (sel: HandSelector): Handedness[] =>
  sel === 'either' ? ['left', 'right'] : [sel];

/** Evaluates a per-hand condition with one dwell gate per hand; any selected hand may satisfy it. */
class PerHand implements CheckEvaluator {
  private readonly gates: Partial<Record<Handedness, DwellGate>> = {};

  constructor(
    private readonly hands: Handedness[],
    dwellMs: number,
    private readonly condition: (hand: HandSample, which: Handedness, ctx: CheckContext) => boolean,
  ) {
    for (const h of hands) this.gates[h] = new DwellGate(dwellMs);
  }

  update(ctx: CheckContext): CheckStatus {
    let best: CheckStatus = { satisfied: false, progress: 0 };
    for (const which of this.hands) {
      const sample = handOf(ctx.frame, which);
      const holds = !!sample && this.condition(sample, which, ctx);
      const s = this.gates[which]?.update(holds, ctx.t) ?? best;
      if (s.satisfied || s.progress > best.progress) best = s;
    }
    return best;
  }
}

export function pinchNear(c: PinchNearCheck): CheckEvaluator {
  return new PerHand(handsFor(c.hand), c.dwellMs, (hand, which, ctx) => {
    const target = ctx.objects.position(c.object);
    return !!target && ctx.pinching[which] && distance(pinchPoint(hand), target) <= c.radius;
  });
}

export function handNear(c: HandNearCheck): CheckEvaluator {
  return new PerHand(handsFor(c.hand), c.dwellMs, (hand, _which, ctx) => {
    const target = ctx.objects.position(c.object);
    return !!target && distance(handPoint(hand, c.point), target) <= c.radius;
  });
}

/** Height is measured in the workspace frame, whose surface is y = 0. */
export function lift(c: LiftCheck): CheckEvaluator {
  return new PerHand(
    handsFor(c.hand),
    c.dwellMs,
    (hand) => handPoint(hand, c.point)[1] >= c.height,
  );
}

export function objectNear(c: ObjectNearCheck): CheckEvaluator {
  const gate = new DwellGate(c.dwellMs);
  return {
    update(ctx) {
      const a = ctx.objects.position(c.object);
      const b = ctx.objects.position(c.target);
      return gate.update(!!a && !!b && distance(a, b) <= c.radius, ctx.t);
    },
  };
}

export function confirm(c: ConfirmCheck): CheckEvaluator {
  return {
    update({ confirmations }) {
      const ok =
        c.by === 'either'
          ? confirmations.coach || confirmations.user
          : c.by === 'coach'
            ? confirmations.coach
            : confirmations.user;
      return { satisfied: ok, progress: ok ? 1 : 0 };
    },
  };
}

export function elapsed(c: ElapsedCheck): CheckEvaluator {
  return {
    update({ t, stepStartT }) {
      const progress = Math.min(1, Math.max(0, (t - stepStartT) / c.ms));
      return { satisfied: progress >= 1, progress };
    },
  };
}
