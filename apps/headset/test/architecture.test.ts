import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Fitness test for the dependency rule in docs/ARCHITECTURE.md §5.1: core/ and domain/ are plain
// TypeScript. They must not import rendering, XR, SDK or emulator packages, nor adapters/ or app/.
// And the coach never sees perception (docs/coach-plan.md): domain/coach/ and the widgets it shows
// (domain/widgets/) import nothing from the world model, the hand tracker or the success checks.

const SRC = join(import.meta.dirname, '..', 'src');
const FORBIDDEN_PACKAGES = [
  /^three(\/|$)/,
  /^troika-three-text/,
  /^@google\/genai/,
  /^iwer/,
  /^@iwer\//,
];
const FORBIDDEN_LAYERS = ['adapters', 'app'];
/** What the coach hears comes from here: never perception. */
const COACH_SIDE = ['domain/coach/', 'domain/widgets/'];
const PERCEPTION = [/^domain\/world\//, /^domain\/hands\//, /^domain\/procedure\/checks(\.ts)?$/];

/** A path relative to src/, with forward slashes. */
const fromSrc = (path: string) => relative(SRC, path).split(/[\\/]/).join('/');

/** Import specifiers in a module's source (static, dynamic and type-only). */
function importsOf(source: string): string[] {
  const specs: string[] = [];
  for (const m of source.matchAll(
    /\bfrom\s+['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s+['"]([^'"]+)['"]/gm,
  )) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (spec) specs.push(spec);
  }
  return specs;
}

function violations(file: string, source: string): string[] {
  return importsOf(source).flatMap((spec) => {
    if (FORBIDDEN_PACKAGES.some((re) => re.test(spec))) return [`${file} imports ${spec}`];
    if (spec.startsWith('.')) {
      const target = fromSrc(resolve(dirname(file), spec));
      const layer = target.split('/')[0] ?? '';
      if (FORBIDDEN_LAYERS.includes(layer)) return [`${file} imports ${spec} (${layer}/)`];
      const coachSide = COACH_SIDE.some((p) => fromSrc(file).startsWith(p));
      if (coachSide && PERCEPTION.some((re) => re.test(target)))
        return [`${file} imports ${spec} (perception, into the coach)`];
    }
    return [];
  });
}

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((e) => (e.isDirectory() ? sourceFiles(join(dir, e.name)) : [join(dir, e.name)])),
  );
  return nested.flat().filter((f) => f.endsWith('.ts'));
}

describe('dependency rule', () => {
  it('detects a forbidden import (the checker itself works)', () => {
    const fake = join(SRC, 'domain', 'x.ts');
    expect(violations(fake, "import * as THREE from 'three';")).toHaveLength(1);
    expect(violations(fake, "import type { Agent } from '../adapters/gemini/agent';")).toHaveLength(
      1,
    );
    expect(violations(fake, "import { add } from '../core/math';")).toHaveLength(0);
  });

  it('detects perception imported into the coach (the checker itself works)', () => {
    const coach = join(SRC, 'domain', 'coach', 'x.ts');
    for (const source of [
      "import { needsConfirmation } from '../procedure/checks';",
      "import type { ObjectOutline } from '../world/outline';",
      "import type { PinchTransition } from '../hands/pinch-detector';",
    ]) {
      expect(violations(coach, source)).toHaveLength(1);
    }
    expect(violations(coach, "import { recitePlan } from '../plan/recital';")).toHaveLength(0);
    expect(violations(coach, "import type { AppBus } from '../events';")).toHaveLength(0);
    const widgets = join(SRC, 'domain', 'widgets', 'x.ts');
    expect(
      violations(widgets, "import type { ObjectOutline } from '../world/outline';"),
    ).toHaveLength(1);
    expect(violations(widgets, "import type { LessonView } from '../coach/ports';")).toHaveLength(
      0,
    );
    const session = join(SRC, 'domain', 'session', 'x.ts');
    expect(violations(session, "import type { Grounder } from '../world/grounding';")).toHaveLength(
      0,
    );
  });

  it('keeps core/ and domain/ framework-free, and perception out of the coach', async () => {
    const files = [
      ...(await sourceFiles(join(SRC, 'core'))),
      ...(await sourceFiles(join(SRC, 'domain'))),
    ];
    expect(files.length).toBeGreaterThan(20);
    const found = (
      await Promise.all(files.map(async (f) => violations(f, await readFile(f, 'utf8'))))
    ).flat();
    expect(found).toEqual([]);
  });
});
