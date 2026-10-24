import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseProcedure } from '@clio/protocol';
import { describe, expect, it } from 'vitest';
import { adaptTemplate, isCalibrated } from '../../src/domain/session/templates';

const PROCEDURES = join(import.meta.dirname, '..', '..', '..', '..', 'procedures');
const load = async (name: string) =>
  parseProcedure(JSON.parse(await readFile(join(PROCEDURES, `${name}.json`), 'utf8')));

describe('adaptTemplate', () => {
  it('runs a curated lesson as written on a calibrated workspace', async () => {
    const ph = await load('ph-indicator');
    expect(adaptTemplate(ph, true)).toBe(ph);
  });

  it('has the camera find the mat objects it can find when the workspace is not calibrated', async () => {
    const ph = adaptTemplate(await load('ph-indicator'), false);
    expect(new Set(ph.objects.map((o) => o.placement.method))).toEqual(new Set(['detect']));
    expect(ph.objects.find((o) => o.id === 'cup_a')?.tracking?.query).toMatch(/letter A/);
    const fold = adaptTemplate(await load('shirt-fold'), false);
    expect(fold.objects.map((o) => o.placement.method)).toEqual([
      'layout',
      'layout',
      'layout',
      'layout',
    ]);
    expect(parseProcedure(ph)).toEqual(ph);
  });

  it('knows which workspaces are calibrated', () => {
    expect(isCalibrated('pinch_two_corners')).toBe(true);
    expect(isCalibrated('persisted_anchor')).toBe(true);
    expect(isCalibrated('default_in_front')).toBe(false);
    expect(isCalibrated('none')).toBe(false);
  });
});
