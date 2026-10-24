import type { CheckEvaluator, CheckStatus } from './types';

export function all(children: CheckEvaluator[]): CheckEvaluator {
  return {
    update(ctx) {
      const statuses = children.map((c) => c.update(ctx));
      return {
        satisfied: statuses.every((s) => s.satisfied),
        progress: statuses.reduce((sum, s) => sum + s.progress, 0) / Math.max(1, statuses.length),
      };
    },
  };
}

export function any(children: CheckEvaluator[]): CheckEvaluator {
  return {
    update(ctx) {
      let best: CheckStatus = { satisfied: false, progress: 0 };
      for (const c of children) {
        const s = c.update(ctx);
        if (s.satisfied || s.progress > best.progress) best = s;
      }
      return best;
    },
  };
}

/** Only the current child is evaluated; once it passes it latches and the next one starts. */
export function sequence(children: CheckEvaluator[]): CheckEvaluator {
  let index = 0;
  return {
    update(ctx) {
      const n = children.length;
      while (index < n) {
        const s = children[index]?.update(ctx);
        if (!s?.satisfied) return { satisfied: false, progress: (index + (s?.progress ?? 0)) / n };
        index++;
      }
      return { satisfied: true, progress: 1 };
    },
  };
}
