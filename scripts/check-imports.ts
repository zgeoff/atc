// Checks the import graph under src/: no cycles (type-only imports count),
// each directory imports only the directories its row allows, and the
// packages that belong to one owner are imported nowhere else. Modules at the
// src/ root are the composition root and may import any directory, and test
// files are exempt from the direction rules. Prints
// every finding and exits 1 when there is one.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const ALLOWED_IMPORTS: Readonly<Record<string, readonly string[]>> = {
  shared: [],
  protocol: ['shared'],
  agents: ['shared', 'protocol'],
  workspace: ['shared', 'protocol'],
  store: ['shared', 'protocol'],
  daemon: ['shared', 'protocol', 'agents', 'workspace', 'store'],
  client: ['shared', 'protocol'],
  mcp: ['shared', 'protocol'],
};

const CONFINED_PACKAGES: Readonly<Record<string, readonly string[]>> = {
  'bun-pty': ['src/daemon/local-pty-provider.ts'],
  '@zgeoff/imp-client': ['src/daemon/imp-client-port.ts'],
  '@anthropic-ai/claude-agent-sdk': [
    'src/agents/build-claude-query-options.ts',
    'src/agents/start-claude-headless-run.ts',
  ],
};

function main(): void {
  const root = resolve(process.argv[2] ?? join(import.meta.dir, '..'));
  const files = collectSourceFiles(root, 'src');

  const known = new Set(files);
  const graph = new Map<string, string[]>();

  const findings: string[] = [];

  for (const file of files) {
    const specifiers = collectImportSpecifiers(readFileSync(join(root, file), 'utf8'));
    const targets: string[] = [];

    for (const specifier of specifiers) {
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
    `check-imports: ${files.length} files, ${cycles.length} cycles, ${findings.length - cycles.length} other findings`,
  );

  if (findings.length > 0) {
    process.exit(1);
  }
}

function collectSourceFiles(root: string, dir: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(join(root, dir)).toSorted()) {
    const path = `${dir}/${entry}`;

    if (statSync(join(root, path)).isDirectory()) {
      files.push(...collectSourceFiles(root, path));
    } else if (path.endsWith('.ts')) {
      files.push(path);
    }
  }

  return files;
}

// Static imports and re-exports, type-only ones included, side-effect
// imports, and dynamic imports with a literal specifier. Each pattern starts
// at a line's first token, so source embedded in a string literal on one line
// never matches.
const IMPORT_PATTERNS: readonly RegExp[] = [
  /^\s*(?:import|export)\s[^;'"`]*?\bfrom\s*['"](?<specifier>[^'"]+)['"]/gm,
  /^\s*import\s*['"](?<specifier>[^'"]+)['"]/gm,
  /\bimport\(\s*['"](?<specifier>[^'"]+)['"]\s*\)/g,
];

function collectImportSpecifiers(source: string): string[] {
  const specifiers = new Set<string>();

  for (const pattern of IMPORT_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match.groups?.['specifier'];

      if (specifier !== undefined) {
        specifiers.add(specifier);
      }
    }
  }

  return [...specifiers];
}

function resolveImport(file: string, specifier: string, known: ReadonlySet<string>): string | null {
  const base = relative('.', join(dirname(file), specifier.replace(/\.js$/, '')));

  for (const candidate of [base, `${base}.ts`, `${base}/index.ts`]) {
    if (known.has(candidate)) {
      return candidate;
    }
  }

  return null;
}

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

function checkDirection(file: string, targets: readonly string[]): string[] {
  const from = findLayer(file);

  // a test wires real modules from several directories together, so only
  // production modules are held to the direction rules
  if (from === null || file.endsWith('.test.ts')) {
    return [];
  }

  const allowed = ALLOWED_IMPORTS[from];

  if (allowed === undefined) {
    return [`unknown directory: ${file} is in src/${from}/, which has no import rule`];
  }

  const findings: string[] = [];

  for (const target of targets) {
    const to = findLayer(target) ?? 'the src root';

    if (to !== from && !allowed.includes(to)) {
      findings.push(`forbidden edge: ${file} imports ${target} (${from} -> ${to})`);
    }
  }

  return findings;
}

/**
 * The first directory under src/, or null for a module at the src/ root.
 */
function findLayer(file: string): string | null {
  const parts = file.split('/');

  return parts.length > 2 ? (parts[1] ?? null) : null;
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
