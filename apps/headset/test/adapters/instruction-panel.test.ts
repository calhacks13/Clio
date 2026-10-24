// The presenter pulls in troika text, whose typings live with the source (tsconfig.node.json
// covers only test/), so point the typecheck at them.
/// <reference path="../../src/adapters/render/troika.d.ts" />
import { describe, expect, it } from 'vitest';
import { stepHeader } from '../../src/adapters/render/presenters/instruction-panel';

describe('instruction panel header', () => {
  it('shows the lesson and the step count, separated by spaces only', () => {
    expect(stepHeader('Refill', 0, 3)).toBe('REFILL   STEP 1 OF 3');
    expect(stepHeader(null, 1, 2)).toBe('LESSON   STEP 2 OF 2');
  });

  it('never counts past the last step', () => {
    expect(stepHeader('Refill', 3, 3)).toBe('REFILL   STEP 3 OF 3');
  });

  it('uses no bullet or middle-dot separators', () => {
    expect(stepHeader('Refill', 0, 3)).not.toMatch(/[\u00b7\u2022]/);
  });
});
