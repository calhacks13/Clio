import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProcedureInput } from '@clio/protocol';

/** A minimal valid procedure (input shape: defaults omitted). */
export function procedureInput(
  id: string,
  overrides: Partial<ProcedureInput> = {},
): ProcedureInput {
  return {
    schema: 'clio.procedure/1',
    id,
    version: 1,
    title: `Title of ${id}`,
    summary: `Summary of ${id}.`,
    workspace: { size: [0.6, 0.4] },
    objects: [
      { id: 'cup_a', label: 'cup A', placement: { method: 'layout', position: [0.1, 0, -0.1] } },
    ],
    steps: [
      {
        id: 'touch-cup',
        instruction: 'Touch cup A.',
        targets: ['cup_a'],
        success: { type: 'hand_near', object: 'cup_a' },
      },
      { id: 'done', instruction: 'Say done.', success: { type: 'confirm' } },
    ],
    ...overrides,
  };
}

export function generatedInput(id: string, createdAt: string, goal = `do ${id}`): ProcedureInput {
  return procedureInput(id, {
    origin: { kind: 'generated', goal, model: 'planner-test', createdAt },
  });
}

export async function writeJson(dir: string, file: string, value: unknown): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, file), JSON.stringify(value, null, 2));
}
