import type { ObjectSpec } from '@clio/protocol';

/**
 * The words an object finder gets for a declared object outside a step's own show item: its
 * tracking query, with the planner's placement hint added when the query doesn't already say it.
 * The finder sees one frame and these words, so where the object is must be in them.
 */
export function findWords(spec: ObjectSpec): string {
  const look = spec.tracking?.query ?? spec.description ?? spec.label;
  const hint = spec.placement.method === 'detect' ? spec.placement.hint?.trim() : undefined;
  if (!hint || look.toLowerCase().includes(hint.toLowerCase())) return look;
  return `${look.replace(/[.\s]+$/, '')}, ${hint}`;
}
