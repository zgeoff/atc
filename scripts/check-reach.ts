// Checks what the atc-gateway entry can reach. The gateway binary must never
// start a daemon or run a session on its own machine, so nothing it imports,
// however indirectly and type-only imports included, may belong to a package
// outside its allowance: core, protocol, config, gateway, mcp, reporters,
// store's sqlite folder for the mcp-auth.db opener, and the app's gateway
// modules. The package map gives each file its final package, so a file is
// held to the rule whether it still sits in packages/app/src or in its
// package; a file the gateway reaches with no row in the map is a finding, so
// the map stays complete. A second step bundles the entry with
// `bun build --metafile` and holds every bundled source file to the same
// rule, which catches a reach the source walk cannot read. Prints every
// finding and exits 1 when there is one.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, normalize, resolve } from 'node:path';
import { collectImports } from './collect-imports';
import { collectSourceFiles } from './collect-source-files';

async function main(): Promise<void> {
  const root = resolve(process.argv[2] ?? join(import.meta.dir, '..'));
  const map = loadPackageMap(root);
  const reached = collectReached(root, ENTRY);

  const bundled = await collectBundled(root, ENTRY);

  const findings = [
    ...[...reached.files].toSorted().flatMap((file) => checkFile(map, 'reaches', file)),
    ...reached.unresolved,
    ...bundled.toSorted().flatMap((file) => checkFile(map, 'bundles', file)),
  ];

  for (const finding of findings) {
    console.error(finding);
  }

  console.log(
    `check-reach: ${reached.files.size} files reached, ${bundled.length} bundled, ${findings.length} findings`,
  );

  if (findings.length > 0) {
    process.exit(1);
  }
}

const ENTRY = 'packages/app/src/gateway.ts';

// The packages whose files the gateway may reach, any folder.
const ALLOWED_PACKAGES: ReadonlySet<string> = new Set([
  'core',
  'protocol',
  'config',
  'gateway',
  'mcp',
  'reporters',
]);

// The app modules behind the atc-gateway binary's own commands, as the
// package map's source paths. Every other app module, cli.ts and the atc
// subcommand modules among them, is out of the gateway's reach.
const GATEWAY_APP_MODULES: ReadonlySet<string> = new Set([
  'src/gateway.ts',
  'src/run-gateway-cli.ts',
  'src/run-gateway.ts',
  'src/parse-gateway-state-dir.ts',
  'src/parse-port.ts',
  'src/collect-redirect-uris.ts',
]);

interface MapRow {
  readonly source: string;
  readonly pkg: string;
  readonly folder: string;
}

const MAP_DIR = 'scripts/package-map';

/**
 * Every path a file has in any wave of the stage map, keyed to the file's
 * row. A file that a later ticket deletes or retires takes the package it
 * sits in until then.
 */
function loadPackageMap(root: string): Map<string, MapRow> {
  const folders = new Map(
    readTable(join(root, MAP_DIR, 'package-filemap.tsv')).map((row) => [
      row['source'] ?? '',
      row['folder'] ?? '',
    ]),
  );

  const interim = JSON.parse(readFileSync(join(root, MAP_DIR, 'interim.json'), 'utf8')) as Readonly<
    Record<string, string>
  >;

  const map = new Map<string, MapRow>();

  for (const row of readTable(join(root, MAP_DIR, 'package-stagemap.tsv'))) {
    const source = row['source'] ?? '';
    const final = row['final'] ?? '';
    const pkg = final.startsWith('(') ? (interim[source] ?? final) : final;

    const paths = Object.entries(row)
      .filter(([column]) => column.startsWith('path_wave'))
      .map(([, path]) => path);

    for (const path of new Set([source, ...paths])) {
      map.set(path, { source, pkg, folder: folders.get(source) ?? '' });
    }
  }

  return map;
}

function readTable(path: string): Record<string, string>[] {
  const [header = '', ...lines] = readFileSync(path, 'utf8').trimEnd().split('\n');
  const columns = header.split('\t');

  return lines.map((line) => {
    const cells = line.split('\t');

    return Object.fromEntries(columns.map((column, i) => [column, cells[i] ?? '']));
  });
}

function checkFile(map: ReadonlyMap<string, MapRow>, verb: string, file: string): string[] {
  if (!file.endsWith('.ts')) {
    return [];
  }

  const row = map.get(file);

  if (row === undefined) {
    return [`unmapped module: ${ENTRY} ${verb} ${file}, which has no row in the package map`];
  }

  const allowed =
    ALLOWED_PACKAGES.has(row.pkg) ||
    (row.pkg === 'store' && row.folder === 'sqlite') ||
    (row.pkg === 'app' && GATEWAY_APP_MODULES.has(row.source));

  return allowed ? [] : [`unreachable module: ${ENTRY} ${verb} ${file} (${row.pkg})`];
}

interface Reach {
  readonly files: ReadonlySet<string>;
  readonly unresolved: readonly string[];
}

/**
 * Every workspace source file the entry imports, however indirectly. An
 * `@atc/*` import resolves through the target package's exports.
 */
function collectReached(root: string, entry: string): Reach {
  const known = new Set(collectSourceFiles(root, 'packages'));

  const exports = collectExports(root);

  const files = new Set([entry]);

  const unresolved: string[] = [];
  const pending = [entry];

  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    const source = readFileSync(join(root, file), 'utf8');

    for (const specifier of collectImports(source).specifiers) {
      const target = resolveSpecifier(known, exports, file, specifier);

      if (target === null) {
        unresolved.push(`unresolved import: ${file} imports ${specifier}`);
      } else if (target !== undefined && !files.has(target)) {
        files.add(target);
        pending.push(target);
      }
    }
  }

  return { files, unresolved };
}

/**
 * The workspace source file a specifier names: null when it names none that
 * exists, undefined when it names an external package or a non-source file.
 */
function resolveSpecifier(
  known: ReadonlySet<string>,
  exports: ReadonlyMap<string, string>,
  file: string,
  specifier: string,
): string | null | undefined {
  if (specifier.startsWith('.')) {
    const dir = dirname(file);

    return findModule(known, normalize(join(dir, specifier)));
  }

  if (specifier.startsWith('@atc/')) {
    return exports.get(specifier) ?? null;
  }

  return undefined;
}

/**
 * The module a relative path names, or null when no source file matches it.
 * A path that leaves every source file, such as a package.json, resolves to
 * undefined: the walk follows source modules only.
 */
function findModule(known: ReadonlySet<string>, base: string): string | null | undefined {
  const path = base.replace(/\.js$/, '');

  for (const candidate of [path, `${path}.ts`, `${path}/index.ts`]) {
    if (known.has(candidate)) {
      return candidate;
    }
  }

  return path.endsWith('.json') ? undefined : null;
}

interface PackageManifest {
  readonly name?: string;
  readonly exports?: Readonly<Record<string, string>>;
}

/**
 * Each workspace entry point's specifier, such as `@atc/store/sqlite`, keyed
 * to the source file it exports.
 */
function collectExports(root: string): Map<string, string> {
  const exports = new Map<string, string>();

  for (const path of new Bun.Glob('packages/**/package.json').scanSync({ cwd: root })) {
    if (path.includes('node_modules')) {
      continue;
    }

    const manifest = JSON.parse(readFileSync(join(root, path), 'utf8')) as PackageManifest;

    for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
      const specifier = subpath === '.' ? manifest.name : `${manifest.name}/${subpath.slice(2)}`;
      const dir = dirname(path);

      if (specifier !== undefined) {
        exports.set(specifier, normalize(join(dir, target)));
      }
    }
  }

  return exports;
}

/**
 * Every source file under the repo root that `bun build` bundles from the
 * entry, packages from node_modules aside.
 */
async function collectBundled(root: string, entry: string): Promise<string[]> {
  const out = mkdtempSync(join(tmpdir(), 'check-reach-'));

  try {
    const build = Bun.spawn(
      [
        process.execPath,
        'build',
        entry,
        '--target=bun',
        `--metafile=${join(out, 'meta.json')}`,
        `--outdir=${join(out, 'bundle')}`,
      ],
      { cwd: root, stdout: 'ignore', stderr: 'pipe' },
    );

    if ((await build.exited) !== 0) {
      throw new Error(`bun build ${entry} failed: ${await new Response(build.stderr).text()}`);
    }

    const meta = (await Bun.file(join(out, 'meta.json')).json()) as {
      readonly inputs: Readonly<Record<string, unknown>>;
    };

    return Object.keys(meta.inputs).filter((input) => !input.split('/').includes('node_modules'));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

await main();
