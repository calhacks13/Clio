import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// The visualizer imports framework-free modules from the headset viewer
// (@clio-viewer/* in tsconfig.json). Those must never reach three.js (the
// headset's copy is a different version) or the headset's DOM and scene code.
// This walks every runtime import, transitively; the no-restricted-imports
// lint rule only sees the visualizer's own direct imports.

const VISUALIZER = path.resolve(import.meta.dir, "../../../..");
const VIEWER = path.resolve(VISUALIZER, "../apps/headset/src/viewer");
const PROTOCOL = path.resolve(VISUALIZER, "../packages/protocol/src/index.ts");

/** The viewer modules visualizer code may import (plan section 2.3). */
const ALLOWED = [
  "capture/model",
  "capture/from-clio",
  "capture/clio-events",
  "capture/from-package",
  "api",
  "event-log",
  "detection-outline",
];

/** Packages the allowed modules may reach; others resolve from the headset. */
const PACKAGES = new Set(["zod"]);

/** Viewer files that draw or drive the page, never to be reached. */
const FORBIDDEN = [
  "capture/index.ts",
  "capture/object-tracks-view.ts",
  "scene.ts",
  "panel.ts",
  "main.ts",
].map((file) => path.join(VIEWER, file));

const transpilers = {
  ts: new Bun.Transpiler({ loader: "ts" }),
  tsx: new Bun.Transpiler({ loader: "tsx" }),
};

/** Runtime imports only: type-only imports are erased and load nothing. */
function importsOf(file: string): string[] {
  const transpiler = file.endsWith(".tsx") ? transpilers.tsx : transpilers.ts;
  return transpiler
    .scanImports(readFileSync(file, "utf8"))
    .map((entry) => entry.path);
}

function resolveFile(base: string): string | null {
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`];
  return candidates.find((c) => existsSync(c) && statSync(c).isFile()) ?? null;
}

type Target = { file: string } | { pkg: string } | { missing: string };

function resolveImport(from: string, specifier: string): Target {
  let file: string | null;
  if (specifier === "@clio/protocol") file = PROTOCOL;
  else if (specifier.startsWith("@clio-viewer/")) {
    file = resolveFile(
      path.join(VIEWER, specifier.slice("@clio-viewer/".length)),
    );
  } else if (specifier.startsWith(".")) {
    file = resolveFile(path.resolve(path.dirname(from), specifier));
  } else {
    const parts = specifier.split("/");
    return { pkg: parts.slice(0, specifier.startsWith("@") ? 2 : 1).join("/") };
  }
  return file ? { file } : { missing: `${specifier} from ${rel(from)}` };
}

const rel = (file: string) => path.relative(path.dirname(VISUALIZER), file);

/** Problems in the import graph below `entries`, as readable lines. */
function problemsBelow(entries: string[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    if (FORBIDDEN.includes(file)) problems.push(`reaches ${rel(file)}`);
    for (const specifier of importsOf(file)) {
      const target = resolveImport(file, specifier);
      if ("missing" in target)
        problems.push(`cannot resolve ${target.missing}`);
      else if ("pkg" in target) {
        if (!PACKAGES.has(target.pkg)) {
          problems.push(`${rel(file)} imports the package ${target.pkg}`);
        }
      } else queue.push(target.file);
    }
  }
  return problems;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

describe("shared viewer imports", () => {
  test("allowed modules reach neither three.js nor the headset's page code", () => {
    const entries = ALLOWED.map((allowed) => {
      const file = resolveFile(path.join(VIEWER, allowed));
      if (!file) throw new Error(`Allowed module ${allowed} does not exist`);
      return file;
    });
    expect(problemsBelow(entries)).toEqual([]);
  });

  test("the walk catches what it guards against", () => {
    const index = path.join(VIEWER, "capture/index.ts");
    const problems = problemsBelow([index]);
    expect(problems).toContain(`reaches ${rel(index)}`);
    expect(problems.some((p) => p.endsWith("the package three"))).toBe(true);
  });

  test("visualizer code imports only allowed viewer modules", () => {
    const problems: string[] = [];
    for (const file of sourceFiles(path.join(VISUALIZER, "src"))) {
      for (const specifier of importsOf(file)) {
        if (specifier.startsWith("@clio-viewer/")) {
          const name = specifier
            .slice("@clio-viewer/".length)
            .replace(/\.ts$/, "");
          if (!ALLOWED.includes(name)) {
            problems.push(`${rel(file)} imports ${specifier}`);
          }
        } else if (specifier.startsWith(".")) {
          const target = path.resolve(path.dirname(file), specifier);
          if (!target.startsWith(VISUALIZER + path.sep)) {
            problems.push(`${rel(file)} imports ${specifier} by path`);
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });
});
