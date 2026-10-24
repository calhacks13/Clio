import type { Check } from '@clio/protocol';
import { all, any, sequence } from './composite';
import { confirm, elapsed, handNear, lift, objectNear, pinchNear } from './leaf';
import type { CheckEvaluator } from './types';

export type { CheckContext, CheckEvaluator, CheckStatus } from './types';

/** Builds a fresh evaluator tree for a check. Add new check types here and in @clio/protocol. */
export function createCheck(check: Check): CheckEvaluator {
  switch (check.type) {
    case 'pinch_near':
      return pinchNear(check);
    case 'hand_near':
      return handNear(check);
    case 'lift':
      return lift(check);
    case 'object_near':
      return objectNear(check);
    case 'confirm':
      return confirm(check);
    case 'elapsed':
      return elapsed(check);
    case 'all':
      return all(check.of.map(createCheck));
    case 'any':
      return any(check.of.map(createCheck));
    case 'sequence':
      return sequence(check.of.map(createCheck));
  }
}

/** True if the check (or any child) waits on a confirmation, e.g. a visual judgment. */
export function needsConfirmation(check: Check): boolean {
  if (check.type === 'confirm') return true;
  return 'of' in check && check.of.some(needsConfirmation);
}
