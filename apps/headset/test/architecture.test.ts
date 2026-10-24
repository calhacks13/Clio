import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Fitness test for the dependency rule in docs/ARCHITECTURE.md §5.1: core/ and domain/ are plain
// TypeScript. They must not import rendering, XR, SDK or emulator packages, nor adapters/ or app/.

const SRC = join(import.meta.dirname, '..', 'src');
const FORBIDDEN_PACKAGES = [
  /^three(\/|$)/,
  /^troika-three-text/,
  /^@google\/genai/,
  /^iwer/,
  /^@iwer\//,
];
const FORBIDDEN_LAYERS = ['adapters', 'app'];

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
      const layer = relative(SRC, resolve(dirname(file), spec)).split(/[\\/]/)[0] ?? '';
      if (FORBIDDEN_LAYERS.includes(layer)) return [`${file} imports ${spec} (${layer}/)`];
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

  it('keeps core/ and domain/ framework-free', async () => {
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
