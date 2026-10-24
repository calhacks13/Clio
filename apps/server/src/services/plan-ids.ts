// Pure id logic for generated plans. Ids are SlugSchema slugs (/^[a-z0-9][a-z0-9_-]{0,63}$/).
// The store tries candidates in order and takes the first one that is free.

const MAX_SLUG = 64;
const MAX_GOAL_SLUG = 48;

/** "Refill the windshield washer fluid!" → "refill-the-windshield-washer-fluid". */
export function slugFromGoal(goal: string): string {
  let slug = goal
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length > MAX_GOAL_SLUG) {
    // Cut at a word boundary when there is one.
    const cut = slug.slice(0, MAX_GOAL_SLUG + 1);
    const dash = cut.lastIndexOf('-');
    slug = dash > 0 ? cut.slice(0, dash) : slug.slice(0, MAX_GOAL_SLUG);
  }
  return slug || 'plan';
}

function withSuffix(base: string, suffix: string): string {
  const room = MAX_SLUG - suffix.length;
  const head = base.length > room ? base.slice(0, room).replace(/[-_]+$/, '') : base;
  return `${head}${suffix}`;
}

/** base, base-2, base-3, … */
export function* goalIdCandidates(base: string): Generator<string, never> {
  yield withSuffix(base, '');
  for (let n = 2; ; n++) yield withSuffix(base, `-${n}`);
}

/** The plan a revision chain started from: "fold-towel-r2" → "fold-towel". */
export function revisionRoot(id: string): string {
  return id.replace(/-r\d+$/, '') || id;
}

/** <root>-r1, <root>-r2, … where root is the plan id without any revision suffix. */
export function* revisionIdCandidates(planId: string): Generator<string, never> {
  const root = revisionRoot(planId);
  for (let n = 1; ; n++) yield withSuffix(root, `-r${n}`);
}
