// Checks that every workspace package's manifest declares what its files
// import, and that no file reaches into another package by a relative path.
// Bun links every workspace package everywhere, so only the manifest proves a dependency.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { dirname, join, normalize, resolve } from 'node:path';
import type { ImportZonesOptions } from '@zgeoff/oxlint-config/import-zones';
import { collectRefusingEdges, importZonesSchema } from '@zgeoff/oxlint-config/import-zones';
import { z } from 'zod';
import type { ImportList } from './collect-imports';
import { collectImports } from './collect-imports';
import { collectSourceFiles } from './collect-source-files';

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
        // A path-only resolve such as `Bun.resolveSync(...)` is not an import:
        // its base directory decides where it resolves
        if (!imports.resolveOnly.includes(specifier)) {
          findings.push(...checkSpecifier(pkg, packages, file, specifier));
        }
      }

      // the root package's tooling resolves computed paths, and no graph
      // reads its resolve forms
      findings.push(...checkComputed(file, imports, pkg.dir !== '.'));
    }
  }

  findings.push(...checkPreloads(root, packages), ...checkDependencyZones(root, packages));

  // the mods belong to no workspace package, but the confinement rules that
  // lint:mods applies read only quoted specifiers too
  const mods = collectSourceFiles(root, 'mods');

  fileCount += mods.length;

  for (const file of mods) {
    const imports = collectImports(readFileSync(join(root, file), 'utf8'));

    findings.push(...checkComputed(file, imports, false));
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

const WORKSPACES_SCHEMA = z
  .object({ packages: z.array(z.string()).optional(), catalog: DEPENDENCIES_SCHEMA })
  .optional();

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
  readonly workspaces?:
    | {
        readonly packages?: readonly string[] | undefined;
        readonly catalog?: Readonly<Record<string, string>> | undefined;
      }
    | undefined;
  readonly dependencies?: Readonly<Record<string, string>> | undefined;
  readonly devDependencies?: Readonly<Record<string, string>> | undefined;
}

interface WorkspacePackage {
  readonly dir: string;
  readonly manifest: Manifest;
}

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

// A full semver version with an optional prerelease and build part, such as
// `1.7.6` or `0.3.0-beta.1`, bare or as an npm alias such as
// `npm:@scope/name@1.7.6`; a range, a tag, or a wildcard matches none.
const EXACT_VERSION =
  /^(?:npm:(?:@[^/@]+\/)?[^/@]+@)?\d+\.\d+\.\d+(?:-[\dA-Za-z.-]+)?(?:\+[\dA-Za-z.-]+)?$/u;

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
    for (const [name, version] of Object.entries(pkg.manifest.workspaces?.catalog ?? {})) {
      if (!EXACT_VERSION.test(version)) {
        findings.push(
          `catalog range: ${manifestPath} catalog has ${name} at ${version}, not an exact version`,
        );
      }
    }

    return findings;
  }

  if (pkg.manifest.name?.startsWith('@atc/') !== true) {
    findings.push(
      `package name: ${manifestPath} is named ${pkg.manifest.name ?? '(none)'}, outside the @atc/ scope`,
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

  return findings;
}

const TEST_SCHEMA = z.object({ preload: z.array(z.string()).optional() });
const BUNFIG_SCHEMA = z.object({ test: TEST_SCHEMA.optional() });

// A preload runs top-level code, which would then run in every importer of
// an entry point that loads it
function checkPreloads(root: string, packages: readonly WorkspacePackage[]): string[] {
  const bunfigPath = join(root, 'bunfig.toml');

  if (!existsSync(bunfigPath)) {
    return [];
  }

  const bunfig = BUNFIG_SCHEMA.parse(Bun.TOML.parse(readFileSync(bunfigPath, 'utf8')));

  const preloads = (bunfig.test?.preload ?? []).map((preload) => ({
    preload,
    file: preload.startsWith('.') ? resolvePreloadFile(root, preload) : undefined,
  }));

  const findings: string[] = [];

  for (const pkg of packages) {
    for (const entry of collectEntryFiles(pkg)) {
      const entryPreload = preloads.find((candidate) => candidate.file === entry);

      if (entryPreload !== undefined) {
        findings.push(
          `preloaded entry: ${entry}, an entry point of ${pkg.dir}, is ${entryPreload.preload}, which bunfig.toml preloads; drop it from the exports map`,
        );
      }

      for (const [file, loads] of collectStaticLoads(root, entry)) {
        findings.push(
          ...loads.flatMap((specifier) => {
            const preload = findPreload(root, preloads, file, specifier);

            return preload === undefined
              ? []
              : [
                  `preloaded module: ${file}, which ${entry} reaches as an entry point of ${pkg.dir}, loads ${specifier}, which bunfig.toml preloads as ${preload}; import it by path`,
                ];
          }),
        );
      }
    }
  }

  return findings;
}

// A preload as bunfig.toml lists it, and the root-relative file a relative
// preload loads.
interface Preload {
  readonly preload: string;
  readonly file: string | undefined;
}

function resolvePreloadFile(root: string, preload: string): string {
  return resolveModule(root, '.', preload) ?? normalize(preload);
}

// The preload a specifier in the file loads, if any.
function findPreload(
  root: string,
  preloads: readonly Preload[],
  file: string,
  specifier: string,
): string | undefined {
  return preloads.find((candidate) =>
    candidate.file === undefined
      ? specifier === candidate.preload
      : resolveModule(root, dirname(file), specifier) === candidate.file,
  )?.preload;
}

// Every path an exports map lists, conditional entries included.
function collectEntryFiles(pkg: WorkspacePackage): string[] {
  const targets: string[] = [];
  const pending: unknown[] = Object.values(pkg.manifest.exports ?? {});

  for (let target = pending.pop(); target !== undefined; target = pending.pop()) {
    if (typeof target === 'string') {
      targets.push(normalize(join(pkg.dir, target)));
    } else if (typeof target === 'object' && target !== null) {
      const conditions: unknown[] = Object.values(target);

      pending.push(...conditions);
    }
  }

  return targets.toSorted();
}

const MODULE_SUFFIXES = [
  '',
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '/index.ts',
  '/index.tsx',
  '/index.js',
  '/index.mjs',
];

const SOURCE_FILE = /\.(?:ts|tsx|js|mjs)$/u;

function collectStaticLoads(root: string, entry: string): Map<string, readonly string[]> {
  const reached = new Map<string, readonly string[]>();

  const pending = [entry];

  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (reached.has(file) || !SOURCE_FILE.test(file) || !existsSync(join(root, file))) {
      continue;
    }

    const loads = collectImports(readFileSync(join(root, file), 'utf8')).staticLoads;

    reached.set(file, loads);

    for (const specifier of loads.filter((candidate) => candidate.startsWith('.'))) {
      const target = resolveModule(root, dirname(file), specifier);

      if (target !== undefined) {
        pending.push(target);
      }
    }
  }

  return reached;
}

// Undefined when no source file matches, as for a text import of a shell script
function resolveModule(root: string, dir: string, specifier: string): string | undefined {
  const base = normalize(join(dir, specifier));

  return MODULE_SUFFIXES.map((suffix) => `${base}${suffix}`).find(
    (path) =>
      SOURCE_FILE.test(path) && existsSync(join(root, path)) && statSync(join(root, path)).isFile(),
  );
}

const IMPORT_ZONES_SCHEMA = z.fromJSONSchema(buildBranchedSchema(importZonesSchema));

const ZONE_OPTIONS_SCHEMA = z.custom<ImportZonesOptions>(
  (value) => IMPORT_ZONES_SCHEMA.safeParse(value).success,
);

const ZONE_RULE_SCHEMA = z.tuple([z.string(), ZONE_OPTIONS_SCHEMA]);

const ZONES_CONFIG_SCHEMA = z.object({
  rules: z.object({ 'zgeoff/import-zones': ZONE_RULE_SCHEMA }),
});

// The lint rule judges only the imports a file holds, so a production
// dependency that no file imports yet would pass it. Each one must pass every
// edge that a runtime import of its root from the package's src/ meets.
function checkDependencyZones(root: string, packages: readonly WorkspacePackage[]): string[] {
  const configPath = join(root, '.oxlintrc.zones.json');

  if (!existsSync(configPath)) {
    return [];
  }

  const config = ZONES_CONFIG_SCHEMA.parse(Bun.JSONC.parse(readFileSync(configPath, 'utf8')));
  const [, options] = config.rules['zgeoff/import-zones'];

  const dirs = new Map(packages.map((pkg) => [pkg.manifest.name, pkg.dir]));

  return packages
    .filter((pkg) => pkg.dir !== '.')
    .flatMap((pkg) =>
      Object.keys(pkg.manifest.dependencies ?? {}).flatMap((name) => {
        const target = dirs.get(name);
        const from = `${pkg.dir}/src/index.ts`;

        const refusing =
          target === undefined ? undefined : collectRefusingEdges(options, { from, to: target })[0];

        return refusing === undefined
          ? []
          : [
              `package rule: ${pkg.dir}/package.json depends on ${name}, which the ${refusing.name} edge in .oxlintrc.zones.json refuses`,
            ];
      }),
    );
}

// z.fromJSONSchema drops `additionalProperties` and the required keys of an
// object that also holds an `anyOf`, as an edge entry does, so each branch
// becomes a whole object that requires its own keys.
function buildBranchedSchema(schema: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return buildBranchedNode(schema);
}

function buildBranchedNode(node: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const { anyOf, ...object } = Object.fromEntries(
    Object.entries(node).map(([key, value]) => [key, buildBranchedValue(value)]),
  );

  if (!Array.isArray(anyOf) || object['properties'] === undefined) {
    return anyOf === undefined ? object : { ...object, anyOf };
  }

  const required: unknown[] = Array.isArray(object['required']) ? object['required'] : [];

  return { anyOf: anyOf.map((branch: unknown) => buildBranch(object, required, branch)) };
}

function buildBranch(
  object: Readonly<Record<string, unknown>>,
  required: readonly unknown[],
  branch: unknown,
): Record<string, unknown> {
  const branchRequired: readonly unknown[] =
    isSchemaObject(branch) && Array.isArray(branch['required']) ? branch['required'] : [];

  return { ...object, required: [...required, ...branchRequired] };
}

function buildBranchedValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item: unknown) => buildBranchedValue(item));
  }

  return isSchemaObject(value) ? buildBranchedNode(value) : value;
}

function isSchemaObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// oxlint's import rules read only quoted specifiers, so they never apply the
// package rules to a computed load, and the import graph cannot follow a
// computed resolve
function checkComputed(file: string, imports: ImportList, withResolves: boolean): string[] {
  return [...imports.computedLoadLines, ...(withResolves ? imports.computedResolveLines : [])]
    .toSorted((a, b) => a - b)
    .map(
      (line) =>
        `computed specifier: ${file}:${line} references a module through a specifier that no import rule can read; quote it`,
    );
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

  return checkDeclared(pkg, file, getPackageName(specifier));
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
