// Checks that every workspace package's manifest declares what its files
// import, and that no file reaches into another package by a relative path.
// Each workspace package lists its entry points in an explicit exports map
// with no wildcard, and an `@atc/*` import of a workspace package names one
// of them: the package itself for `.`, or a named entry such as
// `@atc/protocol/wire`. A bare import resolves to a package the manifest declares: in
// dependencies for production files, in either list for tests and testing
// modules. Each `@atc/*` entry is `workspace:*`, each other entry `catalog:`,
// and a package's `@atc/*` dependencies stay inside its row of the package
// rules. A module load whose specifier is a template literal fails, since
// oxlint's import rules read only quoted specifiers and so would never apply
// the package rules to it. A relative specifier, literal `import()` included, must resolve
// inside the importing file's package. Bun links every workspace package
// where any package can resolve it, so only the manifest proves a package
// meant to depend on another. A specifier that only resolves a path, such as
// `Bun.resolveSync(...)`, is not an import here, since its base directory
// decides where it resolves. The root package holds the repo tooling: e2e/
// and scripts/ declare devDependencies alone. Prints every finding and exits
// 1 when there is one.
import { readFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { dirname, join, normalize, resolve } from 'node:path';
import { z } from 'zod';
import { collectImports } from './collect-imports';
import { collectSourceFiles } from './collect-source-files';
import { PACKAGE_RULES } from './package-rules';

function main(): void {
  const root = resolve(process.argv[2] ?? join(import.meta.dir, '..'));
  const packages = collectPackages(root);
  const findings: string[] = [];
  let fileCount = 0;

  for (const pkg of packages) {
    findings.push(...checkManifest(pkg));

    const files =
      pkg.dir === '.'
        ? ROOT_DIRS.flatMap((dir) => collectSourceFiles(root, dir))
        : collectSourceFiles(root, pkg.dir);

    fileCount += files.length;

    for (const file of files) {
      const imports = collectImports(readFileSync(join(root, file), 'utf8'));

      for (const specifier of imports.specifiers) {
        if (!imports.resolveOnly.includes(specifier)) {
          findings.push(...checkSpecifier(pkg, packages, file, specifier));
        }
      }

      for (const line of imports.templateLines) {
        findings.push(
          `template specifier: ${file}:${line} loads a module through a template literal, which the import lint rules cannot read; quote the specifier`,
        );
      }
    }
  }

  for (const finding of findings) {
    console.error(finding);
  }

  console.log(
    `check-manifests: ${packages.length} packages, ${fileCount} files, ${findings.length} findings`,
  );

  if (findings.length > 0) {
    process.exit(1);
  }
}

// The root package's own source directories.
const ROOT_DIRS = ['e2e', 'scripts'];
const DEPENDENCIES_SCHEMA = z.record(z.string(), z.string()).optional();
const WORKSPACES_SCHEMA = z.object({ packages: z.array(z.string()).optional() }).optional();

const MANIFEST_SCHEMA = z.object({
  name: z.string().optional(),
  exports: z.record(z.string(), z.unknown()).optional(),
  workspaces: WORKSPACES_SCHEMA,
  dependencies: DEPENDENCIES_SCHEMA,
  devDependencies: DEPENDENCIES_SCHEMA,
});

interface Manifest {
  readonly name?: string | undefined;
  readonly exports?: Readonly<Record<string, unknown>> | undefined;
  readonly workspaces?: { readonly packages?: readonly string[] | undefined } | undefined;
  readonly dependencies?: Readonly<Record<string, string>> | undefined;
  readonly devDependencies?: Readonly<Record<string, string>> | undefined;
}

interface WorkspacePackage {
  readonly dir: string;
  readonly manifest: Manifest;
}

/**
 * The root package, then every package the root's workspace globs match, in
 * sorted order.
 */
function collectPackages(root: string): WorkspacePackage[] {
  const manifest = readManifest(root, '.');

  const dirs = new Set<string>();

  for (const pattern of manifest.workspaces?.packages ?? []) {
    for (const path of new Bun.Glob(`${pattern}/package.json`).scanSync({ cwd: root })) {
      dirs.add(dirname(path));
    }
  }

  return [
    { dir: '.', manifest },
    ...[...dirs].toSorted().map((dir) => ({ dir, manifest: readManifest(root, dir) })),
  ];
}

function readManifest(root: string, dir: string): Manifest {
  const text = readFileSync(join(root, dir, 'package.json'), 'utf8');

  return MANIFEST_SCHEMA.parse(JSON.parse(text));
}

function checkManifest(pkg: WorkspacePackage): string[] {
  const findings: string[] = [];
  const manifestPath = pkg.dir === '.' ? 'package.json' : `${pkg.dir}/package.json`;

  for (const [field, entries] of [
    ['dependencies', pkg.manifest.dependencies ?? {}],
    ['devDependencies', pkg.manifest.devDependencies ?? {}],
  ] as const) {
    for (const [name, version] of Object.entries(entries)) {
      const expected = name.startsWith('@atc/') ? 'workspace:*' : 'catalog:';

      if (version !== expected) {
        findings.push(
          `manifest entry: ${manifestPath} ${field} has ${name} at ${version}, not ${expected}`,
        );
      }
    }
  }

  if (pkg.dir === '.') {
    return findings;
  }

  const rule = PACKAGE_RULES.find((candidate) => candidate.dir === pkg.dir);

  if (rule === undefined) {
    return [...findings, `unknown package: ${pkg.dir} has no row in the package rules`];
  }

  if (pkg.manifest.name !== `@atc/${rule.name}`) {
    findings.push(
      `package name: ${manifestPath} is named ${pkg.manifest.name}, not @atc/${rule.name}`,
    );
  }

  // an empty map is explicit too: it leaves a package, such as the app,
  // with no entry point another package can import
  if (pkg.manifest.exports === undefined) {
    findings.push(`no exports: ${manifestPath} holds no exports map`);
  }

  for (const entry of Object.keys(pkg.manifest.exports ?? {}).filter((key) => key.includes('*'))) {
    findings.push(
      `wildcard entry: ${manifestPath} exports ${entry}, which makes every matching file public; list each entry point`,
    );
  }

  for (const name of Object.keys(pkg.manifest.dependencies ?? {})) {
    if (name.startsWith('@atc/') && !rule.deps.includes(name.slice('@atc/'.length))) {
      findings.push(
        `package rule: ${manifestPath} depends on ${name}, outside @atc/${rule.name}'s row`,
      );
    }
  }

  return findings;
}

function checkSpecifier(
  pkg: WorkspacePackage,
  packages: readonly WorkspacePackage[],
  file: string,
  specifier: string,
): string[] {
  if (specifier.startsWith('.')) {
    const target = normalize(join(dirname(file), specifier));
    const owner = findOwner(packages, target);

    if (
      owner === pkg ||
      (pkg.dir === '.' && ROOT_REACHES.some((dir) => target.startsWith(`${dir}/`))) ||
      (APP_TESTS.has(file) && target.startsWith('packages/app/'))
    ) {
      return [];
    }

    return [
      `outside package: ${file} imports ${specifier}, which resolves into ${owner.dir === '.' ? 'the root package' : owner.dir}`,
    ];
  }

  if (isBuiltin(specifier) || specifier.startsWith('bun:') || specifier === 'bun') {
    return [];
  }

  const name = getPackageName(specifier);

  return [...checkEntry(packages, file, specifier, name), ...checkDeclared(pkg, file, name)];
}

/**
 * The finding for an import of a workspace package that names no entry
 * point its exports map lists. An import of a package outside the
 * workspace has none.
 */
function checkEntry(
  packages: readonly WorkspacePackage[],
  file: string,
  specifier: string,
  name: string,
): string[] {
  const target = packages.find((candidate) => candidate.manifest.name === name);

  if (target === undefined || target.dir === '.') {
    return [];
  }

  const entry = specifier === name ? '.' : `./${specifier.slice(name.length + 1)}`;

  return entry in (target.manifest.exports ?? {})
    ? []
    : [
        `unexported entry: ${file} imports ${specifier}, which ${target.dir}/package.json does not list as an entry point`,
      ];
}

function checkDeclared(pkg: WorkspacePackage, file: string, name: string): string[] {
  if (name === pkg.manifest.name || name in (pkg.manifest.dependencies ?? {})) {
    return [];
  }

  if (name in (pkg.manifest.devDependencies ?? {})) {
    return pkg.dir === '.' || isTestFile(file)
      ? []
      : [
          `dev dependency: ${file} imports ${name}, which ${pkg.dir}/package.json declares only for tests`,
        ];
  }

  return [
    `undeclared: ${file} imports ${name}, which ${pkg.dir === '.' ? 'the root package.json' : `${pkg.dir}/package.json`} does not declare`,
  ];
}

// The root package's e2e journeys and scripts reach into the app by path,
// for the app modules and test helpers that no package exports yet.
const ROOT_REACHES = ['packages/app'];

// Tests of shared helpers that drive the helper against app modules no
// package exports yet, such as the daemon client and the reporter line
// format, so each reaches into the app by path.
const APP_TESTS: ReadonlySet<string> = new Set([
  'packages/test-utils/src/build-stub-daemon-requests.test.ts',
  'packages/test-utils/src/keys.test.ts',
  'packages/test-utils/src/run-mcp-authorization.test.ts',
  'packages/test-utils/src/run-passkey-enrollment.test.ts',
  'packages/test-utils/src/run-passkey-sign-in.test.ts',
  'packages/test-utils/src/spawn-claude-session.test.ts',
  'packages/test-utils/src/spawn-grok-session.test.ts',
  'packages/test-utils/src/start-cut-proxy.test.ts',
  'packages/test-utils/src/start-mcp-stdio.test.ts',
  'packages/test-utils/src/start-stub-reporter-socket.test.ts',
  'packages/test-utils/src/start-stub-tap.test.ts',
  'packages/test-utils/src/start-tui-harness.test.ts',
]);

/**
 * The package whose directory holds the path: the deepest workspace package
 * that contains it, or the root package.
 */
function findOwner(packages: readonly WorkspacePackage[], path: string): WorkspacePackage {
  const owners = packages.filter(
    (candidate) => candidate.dir !== '.' && path.startsWith(`${candidate.dir}/`),
  );

  const root = packages.find((candidate) => candidate.dir === '.');

  if (root === undefined) {
    throw new Error('the package list holds no root package');
  }

  return owners.toSorted((a, b) => b.dir.length - a.dir.length)[0] ?? root;
}

// `@scope/name/sub` and `name/sub` both import from one package.
function getPackageName(specifier: string): string {
  const parts = specifier.split('/');

  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier);
}

// Test files, the modules of a testing entry, and the app's own test helpers.
function isTestFile(file: string): boolean {
  return (
    file.endsWith('.test.ts') ||
    file.split('/').includes('testing') ||
    file.startsWith('packages/app/src/test-utils/')
  );
}

main();
