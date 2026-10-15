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
// rule, which catches a reach the source walk cannot read.
//
// A second rule holds the reporters to their start-up time. A hook or
// statusline command starts once per event inside a session, and a compiled
// entry point runs the top-level code of every module it re-exports, so the
// static import graph of each reporter and of cli.ts, whose static imports
// load before every subcommand, reaches no module whose top-level code builds
// schemas, the protocol contract, or the store. Type-only imports and dynamic
// imports load nothing at start-up, so the walk leaves them out. Of the
// packages, the walk may reach core, the light entries of protocol and
// config, and lifecycle's run-command entry. The rule holds for a tree that
// has the atc CLI entry. Prints every finding and exits 1 when there is one.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, normalize, resolve } from 'node:path';
import { z } from 'zod';
import { collectImports } from './collect-imports';
import { collectSourceFiles } from './collect-source-files';
import { PACKAGE_RULES } from './package-rules';

async function main(): Promise<void> {
  const root = resolve(process.argv[2] ?? join(import.meta.dir, '..'));
  const map = loadPackageMap(root);

  const known = new Set(collectSourceFiles(root, 'packages'));

  const exports = collectExports(root);

  const reached = collectReached(
    known,
    exports,
    [ENTRY],
    (file) => collectImports(readFileSync(join(root, file), 'utf8')).specifiers,
  );

  const bundled = await collectBundled(root, ENTRY);

  const findings = [
    ...[...reached.files].toSorted().flatMap((file) => checkFile(map, 'reaches', file)),
    ...reached.unresolved,
    ...bundled
      .filter((file) => known.has(file))
      .toSorted()
      .flatMap((file) => checkFile(map, 'bundles', file)),
    ...checkReporters(root, known, exports),
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
  'src/open-mcp-auth-database.ts',
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

  const interimText = readFileSync(join(root, MAP_DIR, 'interim.json'), 'utf8');
  const interim = z.record(z.string(), z.string()).parse(JSON.parse(interimText));

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

const APP_SOURCE = 'packages/app/src';

// The reporters, and cli.ts, whose static imports load before every
// subcommand, the reporters among them.
const REPORTER_ENTRIES = [
  'cli.ts',
  'hook-report.ts',
  'note.ts',
  'tap.ts',
  'run-bridge-tap.ts',
  'statusline.ts',
].map((file) => `${APP_SOURCE}/${file}`);

// The folders under src/ of each package that a reporter may load, by
// package name: core whole, and the light entries of the packages whose
// root entry builds schemas, the protocol contract, or the store. Every
// other package, store among them, stays out of a reporter's reach.
const REPORTER_FOLDERS: ReadonlyMap<string, readonly string[] | 'all'> = new Map([
  ['core', 'all'],
  ['protocol', ['session', 'wire']],
  ['config', ['host', 'claude-statusline']],
  ['lifecycle', ['run-command']],
]);

/**
 * The findings for the reporters' start-up: each package module that a
 * reporter's static import graph loads outside the folders the reporters
 * may load, a reporter entry that is missing, and a static import that
 * resolves to no file.
 */
function checkReporters(
  root: string,
  known: ReadonlySet<string>,
  exports: ReadonlyMap<string, string>,
): string[] {
  if (!existsSync(join(root, APP_SOURCE, 'cli.ts'))) {
    return [];
  }

  const missing = REPORTER_ENTRIES.filter((entry) => !known.has(entry));

  if (missing.length > 0) {
    return missing.map((entry) => `missing reporter: ${entry} does not exist`);
  }

  const findings: string[] = [];

  for (const entry of REPORTER_ENTRIES) {
    const reached = collectReached(
      known,
      exports,
      [entry],
      (file) => collectImports(readFileSync(join(root, file), 'utf8')).staticLoads,
    );

    for (const file of [...reached.files].toSorted()) {
      if (!isReporterLoadable(file)) {
        findings.push(
          `slow reporter: ${entry} loads ${file} at start-up, outside the entries a reporter may load`,
        );
      }
    }

    findings.push(...reached.unresolved);
  }

  return findings;
}

/**
 * Whether a reporter may load the file at start-up: an app module, or a
 * package module inside a folder that the package's row allows.
 */
function isReporterLoadable(file: string): boolean {
  if (file.startsWith(`${APP_SOURCE}/`)) {
    return true;
  }

  const rule = PACKAGE_RULES.find((candidate) => file.startsWith(`${candidate.dir}/src/`));

  if (rule === undefined) {
    return false;
  }

  const folders = REPORTER_FOLDERS.get(rule.name) ?? [];
  const path = file.slice(`${rule.dir}/src/`.length);

  return folders === 'all' || folders.some((folder) => path.startsWith(`${folder}/`));
}

interface Reach {
  readonly files: ReadonlySet<string>;
  readonly unresolved: readonly string[];
}

/**
 * Every workspace source file the entries import, however indirectly,
 * following the specifiers that `pick` returns for each file. An `@atc/*`
 * import resolves through the target package's exports.
 */
function collectReached(
  known: ReadonlySet<string>,
  exports: ReadonlyMap<string, string>,
  entries: readonly string[],
  pick: (file: string) => readonly string[],
): Reach {
  const files = new Set(entries);

  const unresolved: string[] = [];
  const pending = [...entries];

  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    for (const specifier of pick(file)) {
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
    const target = findExport(exports, specifier);

    return target !== null && known.has(target) ? target : null;
  }

  return undefined;
}

/**
 * The source file an `@atc/*` specifier names: an exact entry point first,
 * then a wildcard entry such as `./*` exporting `./src/*.ts`. Null when no
 * entry matches.
 */
function findExport(exports: ReadonlyMap<string, string>, specifier: string): string | null {
  const exact = exports.get(specifier);

  if (exact !== undefined) {
    return exact;
  }

  for (const [pattern, target] of exports) {
    const [prefix = '', suffix] = pattern.split('*');

    if (
      suffix !== undefined &&
      specifier.startsWith(prefix) &&
      specifier.endsWith(suffix) &&
      specifier.length >= prefix.length + suffix.length
    ) {
      const matched = specifier.slice(prefix.length, specifier.length - suffix.length);

      return target.replace('*', matched);
    }
  }

  return null;
}

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs'];

/**
 * The module a relative path names, or null when no source file matches it.
 * A path that leaves every source file, such as a package.json, resolves to
 * undefined: the walk follows source modules only.
 */
function findModule(known: ReadonlySet<string>, base: string): string | null | undefined {
  const path = base.replace(/\.js$/, '');

  for (const candidate of [
    base,
    path,
    ...SOURCE_EXTENSIONS.map((extension) => `${path}${extension}`),
    `${path}/index.ts`,
  ]) {
    if (known.has(candidate)) {
      return candidate;
    }
  }

  return path.endsWith('.json') ? undefined : null;
}

const PACKAGE_MANIFEST_SCHEMA = z.object({
  name: z.string().optional(),
  exports: z.record(z.string(), z.string()).optional(),
});

/**
 * Each workspace entry point's specifier, such as `@atc/store/sqlite`, keyed
 * to the source file it exports. A wildcard entry keeps its `*` on both
 * sides, such as `@atc/core/*` keyed to `packages/core/src/*.ts`.
 */
function collectExports(root: string): Map<string, string> {
  const exports = new Map<string, string>();

  for (const path of new Bun.Glob('packages/**/package.json').scanSync({ cwd: root })) {
    if (path.includes('node_modules')) {
      continue;
    }

    const text = readFileSync(join(root, path), 'utf8');
    const manifest = PACKAGE_MANIFEST_SCHEMA.parse(JSON.parse(text));

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

    const metafile: unknown = await Bun.file(join(out, 'meta.json')).json();

    const meta = z.object({ inputs: z.record(z.string(), z.unknown()) }).parse(metafile);

    return Object.keys(meta.inputs).filter((input) => !input.split('/').includes('node_modules'));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

await main();
