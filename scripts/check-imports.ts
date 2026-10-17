// Checks the import graph under the app's source root, packages/app/src/: no
// cycles (type-only imports count), and each directory imports only the
// directories its row allows. Modules at the source root have a row of their
// own. The composition root may import any directory, and test files are
// exempt from the direction rules. What the gateway entry may reach is
// check-reach's job, which external packages a file may import is the oxlint
// import rules' job, and a module load whose specifier is not a quoted string
// is check-manifests' job. Prints every finding and exits 1 when there is one.
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { collectImports } from './collect-imports';
import { collectSourceFiles } from './collect-source-files';

function main(): void {
  const root = resolve(process.argv[2] ?? join(import.meta.dir, '..'));
  const files = collectSourceFiles(root, SOURCE_ROOT);

  const known = new Set(files);
  const graph = new Map<string, string[]>();

  const findings: string[] = [];

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
    findings.push(...checkDirection(file, targets));
  }

  const cycles = collectCycles(graph);

  for (const cycle of cycles) {
    findings.push(`cycle among: ${cycle.join(', ')}`);
  }

  for (const finding of findings) {
    console.error(finding);
  }

  console.log(
    `check-imports: ${files.length} files, ${cycles.length} cycles, ${findings.length - cycles.length} other findings`,
  );

  if (findings.length > 0) {
    process.exit(1);
  }
}

// The app's source root, relative to the repo root that paths in findings
// and rules start from.
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

// The entrypoints that wire concrete modules together, exempt from the
// direction rules.
const COMPOSITION_ROOTS: ReadonlySet<string> = new Set([
  'packages/app/src/cli.ts',
  'packages/app/src/gateway.ts',
]);

const ALLOWED_IMPORTS: Readonly<Record<string, readonly string[]>> = {
  shared: [],

  // the plugin registry: the plugins atc ships, from their packages
  plugins: ['shared'],
  agents: ['shared', 'plugins'],
  sources: ['shared', 'plugins'],

  // the client reads the agents from config through the shipped harness
  // plugins
  client: ['shared', 'plugins'],
  mcp: ['shared'],
  federation: ['shared'],

  // modules at the source root: the subcommand modules beside the entrypoints
  root: ['shared', 'agents', 'client', 'mcp', 'federation', 'plugins'],

  // the shared test helpers wire real modules together the way a test does,
  // and no production row lists them, so no production module imports one
  'test-utils': ['shared', 'agents', 'sources', 'client', 'mcp', 'federation', 'root', 'plugins'],
};

function checkDirection(file: string, targets: readonly string[]): string[] {
  // a test wires real modules from several directories together, so only
  // production modules are held to the direction rules
  if (COMPOSITION_ROOTS.has(file) || file.endsWith('.test.ts')) {
    return [];
  }

  const from = getLayer(file);
  const allowed = ALLOWED_IMPORTS[from];

  if (allowed === undefined) {
    return [`unknown directory: ${file} is in ${SOURCE_ROOT}/${from}/, which has no import rule`];
  }

  const findings: string[] = [];

  for (const target of targets) {
    const to = getLayer(target);

    if (to !== from && !allowed.includes(to)) {
      findings.push(`forbidden edge: ${file} imports ${target} (${from} -> ${to})`);
    }
  }

  return findings;
}

/**
 * The first directory under the source root, or `root` for a module at the
 * source root.
 */
function getLayer(file: string): string {
  const parts = relative(SOURCE_ROOT, file).split('/');

  return parts.length > 1 ? (parts[0] ?? 'root') : 'root';
}

/**
 * Tarjan's strongly connected components: every component with more than one
 * file, or a file importing itself, is a cycle.
 */
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
