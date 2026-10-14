// Checks the import graph under the app's source root, packages/app/src/: no
// cycles (type-only imports count), each directory imports only the
// directories its row allows, and the packages that belong to one owner are
// imported nowhere else. Modules at the source root have a row of their own.
// The composition root may import any directory, and test files are exempt
// from the direction rules. An import or module reference whose specifier is
// not a literal is a finding, since no rule can check it. The packages that
// belong to one owner are also checked in e2e/, scripts/, and mods/, outside
// node_modules, whose modules follow no other rule here. What the gateway
// entry may reach is check-reach's job. Prints every finding and exits 1 when
// there is one.
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
  const outside = OUTSIDE_DIRS.flatMap((dir) => collectSourceFiles(root, dir));

  for (const file of outside) {
    for (const specifier of collectImports(readFileSync(join(root, file), 'utf8')).specifiers) {
      findings.push(...checkConfinement(file, specifier));
    }
  }

  for (const file of files) {
    const imports = collectImports(readFileSync(join(root, file), 'utf8'));
    const targets: string[] = [];

    for (const line of imports.nonLiteralLines) {
      findings.push(`non-literal import: ${file}:${line} imports a computed specifier`);
    }

    for (const specifier of imports.specifiers) {
      if (specifier.startsWith('.')) {
        const target = resolveImport(file, specifier, known);

        if (target !== null) {
          targets.push(target);
        }
      } else {
        findings.push(...checkConfinement(file, specifier));
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
    `check-imports: ${files.length + outside.length} files, ${cycles.length} cycles, ${findings.length - cycles.length} other findings`,
  );

  if (findings.length > 0) {
    process.exit(1);
  }
}

// The app's source root, relative to the repo root that paths in findings
// and rules start from.
const SOURCE_ROOT = 'packages/app/src';

// The directories outside the source root whose modules the confinement rule
// covers.
const OUTSIDE_DIRS = ['e2e', 'scripts', 'mods'];

function resolveImport(file: string, specifier: string, known: ReadonlySet<string>): string | null {
  const base = relative('.', join(dirname(file), specifier.replace(/\.js$/, '')));

  for (const candidate of [base, `${base}.ts`, `${base}/index.ts`]) {
    if (known.has(candidate)) {
      return candidate;
    }
  }

  return null;
}

const CONFINED_PACKAGES: Readonly<Record<string, readonly string[]>> = {
  // the fake impd runs its guests in real PTYs, as impd does, the TUI
  // harness runs the real client in one, as a terminal does, and the raw-mode
  // reads of the stub composer and the stub menu need a real terminal to run in
  'bun-pty': [
    'packages/execution/local/src/local-pty-provider.ts',
    'packages/execution/imp/src/testing/create-stub-imp-port.ts',
    'packages/test-utils/src/start-tui-harness.ts',
    'packages/test-utils/src/create-stub-composer.test.ts',
    'packages/test-utils/src/run-stub-menu-claude.test.ts',
  ],
  '@zgeoff/imp-client': ['packages/execution/imp/src/imp-client-port.ts'],
  '@anthropic-ai/claude-agent-sdk': [
    'packages/harnesses/claude/src/headless/build-claude-query-options.ts',
    'packages/harnesses/claude/src/headless/start-claude-headless-run.ts',
  ],
};

function checkConfinement(file: string, specifier: string): string[] {
  const findings: string[] = [];

  for (const [pkg, owners] of Object.entries(CONFINED_PACKAGES)) {
    const isPackage = specifier === pkg || specifier.startsWith(`${pkg}/`);

    if (isPackage && !owners.includes(file)) {
      findings.push(
        `confined package: ${file} imports ${pkg}, allowed only in ${owners.join(', ')}`,
      );
    }
  }

  return findings;
}

// The entrypoints that wire concrete modules together, exempt from the
// direction rules.
const COMPOSITION_ROOTS: ReadonlySet<string> = new Set([
  'packages/app/src/cli.ts',
  'packages/app/src/gateway.ts',
]);

const ALLOWED_IMPORTS: Readonly<Record<string, readonly string[]>> = {
  shared: [],
  protocol: ['shared'],

  // the plugin registry: the plugins atc ships, from their packages
  plugins: ['shared', 'protocol'],
  agents: ['shared', 'protocol', 'plugins'],
  workspace: ['shared', 'protocol'],
  sources: ['shared', 'protocol', 'workspace', 'plugins'],
  store: ['shared', 'protocol'],
  daemon: ['shared', 'protocol', 'agents', 'workspace', 'sources', 'store', 'plugins'],

  // the client reads the agents from config through the shipped harness
  // plugins
  client: ['shared', 'protocol', 'plugins'],
  mcp: ['shared', 'protocol'],
  federation: ['shared', 'protocol'],

  // modules at the source root: the subcommand modules beside the entrypoints
  root: ['shared', 'protocol', 'agents', 'client', 'mcp', 'federation', 'plugins'],

  // the shared test helpers wire real modules together the way a test does,
  // and no production row lists them, so no production module imports one
  'test-utils': [
    'shared',
    'protocol',
    'agents',
    'workspace',
    'sources',
    'store',
    'daemon',
    'client',
    'mcp',
    'federation',
    'root',
    'plugins',
  ],
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
