// Checks the import graph under packages/app/src/ for cycles, counting
// type-only imports.
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { collectImports } from './collect-imports';
import { readSourceFiles } from './read-source-files';

function main(): void {
  const root = resolve(process.argv[2] ?? join(import.meta.dir, '..'));
  const files = readSourceFiles(root, SOURCE_ROOT);

  const known = new Set(files);
  const graph = new Map<string, string[]>();

  for (const file of files) {
    const imports = collectImports(readFileSync(join(root, file), 'utf8'));
    const targets: string[] = [];

    for (const specifier of imports.specifiers.filter((candidate) => candidate.startsWith('.'))) {
      const target = resolveImport(file, specifier, known);

      if (target !== null) {
        targets.push(target);
      }
    }

    graph.set(file, targets);
  }

  const cycles = collectCycles(graph);

  for (const cycle of cycles) {
    console.error(`cycle among: ${cycle.join(', ')}`);
  }

  console.log(`check-imports: ${files.length} files, ${cycles.length} cycles`);

  if (cycles.length > 0) {
    process.exit(1);
  }
}

// The app's source root, relative to the repo root that paths in findings
// start from.
const SOURCE_ROOT = 'packages/app/src';

function resolveImport(file: string, specifier: string, known: ReadonlySet<string>): string | null {
  const base = relative('.', join(dirname(file), specifier.replace(/\.js$/u, '')));

  for (const candidate of [base, `${base}.ts`, `${base}/index.ts`]) {
    if (known.has(candidate)) {
      return candidate;
    }
  }

  return null;
}

// Tarjan's strongly connected components: every component with more than one
// file, or a file importing itself, is a cycle
function collectCycles(graph: ReadonlyMap<string, readonly string[]>): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();

  const stack: string[] = [];

  const onStack = new Set<string>();

  const cycles: string[][] = [];
  let next = 0;

  const collectComponent = (file: string): void => {
    index.set(file, next);
    low.set(file, next);

    next += 1;

    stack.push(file);
    onStack.add(file);

    for (const target of graph.get(file) ?? []) {
      if (!index.has(target)) {
        collectComponent(target);

        low.set(file, Math.min(low.get(file) ?? 0, low.get(target) ?? 0));
      } else if (onStack.has(target)) {
        low.set(file, Math.min(low.get(file) ?? 0, index.get(target) ?? 0));
      }
    }

    if (low.get(file) !== index.get(file)) {
      return;
    }

    const component: string[] = [];
    let member: string | undefined;

    do {
      member = stack.pop();

      if (member !== undefined) {
        onStack.delete(member);
        component.push(member);
      }
    } while (member !== undefined && member !== file);

    if (component.length > 1 || (graph.get(file) ?? []).includes(file)) {
      cycles.push(component.toSorted());
    }
  };

  for (const file of graph.keys()) {
    if (!index.has(file)) {
      collectComponent(file);
    }
  }

  return cycles;
}

main();
