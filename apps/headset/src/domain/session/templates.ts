import type { CalibrationMethod, ObjectSpec, Procedure } from '@clio/protocol';

// Curated lessons (procedures/*.json) as starting points: the coach starts one with
// start_lesson(template_id) and then adapts it like any other plan.

export interface TemplateSummary {
  id: string;
  title: string;
  summary: string;
}

/** Port: the curated lessons (the server's /api/procedures, curated ones only). */
export interface TemplateSource {
  list(): Promise<TemplateSummary[]>;
  get(id: string): Promise<Procedure>;
}

const CALIBRATED: ReadonlySet<CalibrationMethod> = new Set([
  'pinch_two_corners',
  'workspace_marker',
  'persisted_anchor',
]);

export const isCalibrated = (method: CalibrationMethod): boolean => CALIBRATED.has(method);

/** Things the camera can find. Points and regions exist only on the taped mat. */
const FINDABLE: ReadonlySet<ObjectSpec['kind']> = new Set(['item', 'container', 'tool']);

/**
 * Fits a curated lesson to this setup. On a calibrated workspace its taped-mat positions hold, so
 * it runs as written. Otherwise those positions mean nothing, so the camera looks for every object
 * it can find instead (by its tracking query, else its label).
 */
export function adaptTemplate(procedure: Procedure, calibrated: boolean): Procedure {
  if (calibrated) return procedure;
  return {
    ...procedure,
    objects: procedure.objects.map((o) =>
      o.placement.method === 'layout' && FINDABLE.has(o.kind)
        ? { ...o, placement: { method: 'detect' as const } }
        : o,
    ),
  };
}
