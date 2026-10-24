import { chmod, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ApiPaths, ProcedureListResponseSchema, ProcedureSchema } from '@clio/protocol';
import { describe, expect, it, onTestFinished } from 'vitest';
import { REPO_ROOT } from '../src/config';
import { ProcedureStore } from '../src/storage/procedure-store';
import { captureLogger, harness, tempDir } from './harness';
import { generatedInput, procedureInput, writeJson } from './procedure-fixtures';

const summary = (id: string, source: 'curated' | 'generated') => ({
  id,
  version: 1,
  title: `Title of ${id}`,
  summary: `Summary of ${id}.`,
  stepCount: 2,
  source,
});

describe('GET /api/procedures', () => {
  it('lists curated procedures by id, then generated plans newest first', async () => {
    const h = await harness();
    await writeJson(h.proceduresDir, 'b-task.json', procedureInput('b-task'));
    await writeJson(h.proceduresDir, 'a-task.json', procedureInput('a-task'));
    const plansDir = join(h.dataDir, 'plans');
    await writeJson(
      plansDir,
      'old-plan.json',
      generatedInput('old-plan', '2026-10-24T03:00:00.000Z'),
    );
    await writeJson(
      plansDir,
      'new-plan.json',
      generatedInput('new-plan', '2026-10-24T04:00:00.000Z'),
    );

    const res = await h.request('GET', ApiPaths.procedures);
    expect(res.status).toBe(200);
    expect(ProcedureListResponseSchema.parse(await res.json())).toEqual({
      procedures: [
        summary('a-task', 'curated'),
        summary('b-task', 'curated'),
        summary('new-plan', 'generated'),
        summary('old-plan', 'generated'),
      ],
    });
  });

  it('skips and logs invalid files (once per file version) instead of failing', async () => {
    const h = await harness();
    await writeJson(h.proceduresDir, 'good.json', procedureInput('good'));
    await writeFile(join(h.proceduresDir, 'broken.json'), '{ not json');
    await writeJson(h.proceduresDir, 'invalid.json', { ...procedureInput('invalid'), steps: [] });
    await writeFile(join(h.proceduresDir, 'notes.txt'), 'not a procedure');

    for (let i = 0; i < 2; i++) {
      const res = await h.request('GET', ApiPaths.procedures);
      expect(res.status).toBe(200);
      const body = ProcedureListResponseSchema.parse(await res.json());
      expect(body.procedures).toEqual([summary('good', 'curated')]);
    }
    const warnings = h.logger.lines.filter((l) => l.startsWith('warn'));
    expect(warnings).toHaveLength(2);
    expect(warnings.some((w) => w.includes('broken.json'))).toBe(true);
    expect(warnings.some((w) => w.includes('invalid.json'))).toBe(true);
  });

  it('hides a generated plan whose id clashes with a curated procedure', async () => {
    const h = await harness();
    await writeJson(h.proceduresDir, 'clash.json', procedureInput('clash'));
    await writeJson(
      join(h.dataDir, 'plans'),
      'clash.json',
      generatedInput('clash', '2026-10-24T03:00:00.000Z'),
    );
    const res = await h.request('GET', ApiPaths.procedures);
    expect(ProcedureListResponseSchema.parse(await res.json()).procedures).toEqual([
      summary('clash', 'curated'),
    ]);
  });
});

describe('GET /api/procedures/:id', () => {
  it('returns the parsed procedure with every default filled in', async () => {
    const h = await harness();
    await writeJson(h.proceduresDir, 'demo.json', {
      $schema: '../packages/protocol/schema/procedure.schema.json',
      ...procedureInput('demo'),
    });
    const res = await h.request('GET', ApiPaths.procedure('demo'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      schema: 'clio.procedure/1',
      id: 'demo',
      version: 1,
      origin: { kind: 'curated' },
      title: 'Title of demo',
      summary: 'Summary of demo.',
      workspace: { size: [0.6, 0.4] },
      objects: [
        {
          id: 'cup_a',
          label: 'cup A',
          kind: 'item',
          radius: 0.03,
          hidden: false,
          placement: { method: 'layout', position: [0.1, 0, -0.1] },
        },
      ],
      steps: [
        {
          id: 'touch-cup',
          instruction: 'Touch cup A.',
          targets: ['cup_a'],
          hand: 'either',
          success: {
            type: 'hand_near',
            object: 'cup_a',
            hand: 'either',
            point: 'pinch',
            radius: 0.06,
            dwellMs: 250,
          },
          mistakes: [],
        },
        {
          id: 'done',
          instruction: 'Say done.',
          targets: [],
          hand: 'either',
          success: { type: 'confirm', by: 'either' },
          mistakes: [],
        },
      ],
      coach: {},
    });
  });

  it('resolves generated plans, and the curated procedure wins an id clash', async () => {
    const h = await harness();
    const plansDir = join(h.dataDir, 'plans');
    await writeJson(plansDir, 'towel.json', generatedInput('towel', '2026-10-24T03:00:00.000Z'));
    await writeJson(h.proceduresDir, 'clash.json', procedureInput('clash', { title: 'Curated' }));
    await writeJson(plansDir, 'clash.json', {
      ...generatedInput('clash', '2026-10-24T03:00:00.000Z'),
      title: 'Generated',
    });

    const towel = ProcedureSchema.parse(
      await (await h.request('GET', ApiPaths.procedure('towel'))).json(),
    );
    expect(towel.origin).toEqual({
      kind: 'generated',
      goal: 'do towel',
      model: 'planner-test',
      createdAt: '2026-10-24T03:00:00.000Z',
    });
    const clash = await h.request('GET', ApiPaths.procedure('clash'));
    expect(ProcedureSchema.parse(await clash.json()).title).toBe('Curated');
  });

  it('answers 404 for unknown ids and 400 for unsafe ones', async () => {
    const h = await harness();
    expect((await h.request('GET', ApiPaths.procedure('nope'))).status).toBe(404);
    expect((await h.request('GET', '/api/procedures/..%2Fsecrets')).status).toBe(400);
  });
});

describe('ProcedureStore', () => {
  it('loads the real curated procedures', async () => {
    const store = new ProcedureStore({
      curatedDir: join(REPO_ROOT, 'procedures'),
      plansDir: join(await tempDir(), 'plans'),
      logger: captureLogger(),
    });
    const ids = (await store.list()).map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(['ph-indicator', 'shirt-fold']));
  });

  it('saves plans under the first free id and leaves no temp files behind', async () => {
    const root = await tempDir();
    const store = new ProcedureStore({
      curatedDir: join(root, 'procedures'),
      plansDir: join(root, 'plans'),
    });
    const plan = ProcedureSchema.parse(generatedInput('towel', '2026-10-24T03:00:00.000Z'));
    const first = await store.savePlan(plan, ['towel', 'towel-2']);
    const second = await store.savePlan(plan, ['towel', 'towel-2']);
    expect([first.id, second.id]).toEqual(['towel', 'towel-2']);
    expect((await readdir(join(root, 'plans'))).sort()).toEqual(['towel-2.json', 'towel.json']);
    await expect(store.savePlan(plan, ['towel', 'towel-2'])).rejects.toThrow(/No free plan id/);
  });

  it.skipIf(process.getuid?.() === 0)(
    'keeps listing curated procedures when the plans folder is unreadable',
    async () => {
      const root = await tempDir();
      const logger = captureLogger();
      const plansDir = join(root, 'plans');
      await writeJson(join(root, 'procedures'), 'demo.json', procedureInput('demo'));
      await writeJson(plansDir, 'towel.json', generatedInput('towel', '2026-10-24T03:00:00.000Z'));
      await chmod(plansDir, 0o000);
      onTestFinished(() => chmod(plansDir, 0o755));
      const store = new ProcedureStore({ curatedDir: join(root, 'procedures'), plansDir, logger });
      expect((await store.list()).map((p) => p.id)).toEqual(['demo']);
      expect(logger.lines.some((l) => l.startsWith('warn') && l.includes(plansDir))).toBe(true);
    },
  );
});
