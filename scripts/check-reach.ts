// Checks what the atc-gateway entry can reach. The gateway binary must never
// start a daemon or run a session on its own machine, so nothing it imports,
// type-only imports included, may belong to a package outside its allowance.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, normalize, resolve } from 'node:path';
import { z } from 'zod';
import { collectImports } from './collect-imports';
import { collectSourceFiles } from './collect-source-files';
import { PACKAGE_RULES } from './package-rules';

async function main(): Promise<void> {
  const root = resolve(process.argv[2] ?? join(import.meta.dir, '..'));

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
    ...[...reached.files].toSorted().flatMap((file) => checkFile('reaches', file)),
    ...reached.unresolved,
    ...bundled
      .filter((file) => known.has(file))
      .toSorted()
      .flatMap((file) => checkFile('bundles', file)),
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

// The app modules behind the atc-gateway binary's own commands, as paths
// under the app's src/: a path that ends in `/` holds every file in that
// folder. Every other app module, cli.ts among them, is out of reach.
const GATEWAY_APP_MODULES: readonly string[] = [
  'gateway.ts',
  'run-gateway-cli.ts',
  'run-gateway.ts',
  'open-mcp-auth-database.ts',
  'parse-gateway-state-dir.ts',
  'parse-port.ts',
  'collect-redirect-uris.ts',
  'clients.ts',
  'passkeys.ts',
  'shared/grant-scope.ts',
  'shared/normalize-client-name.ts',
  'mcp/',
  'federation/',
];

function checkFile(verb: string, file: string): string[] {
  const owner = findPackage(file);

  if (owner === undefined) {
    return [
      `unowned module: ${ENTRY} ${verb} ${file}, which sits in no package directory that scripts/package-rules.ts lists`,
    ];
  }

  const allowed =
    ALLOWED_PACKAGES.has(owner.name) ||
    (owner.name === 'store' && owner.path.startsWith('src/sqlite/')) ||
    (owner.name === 'app' &&
      GATEWAY_APP_MODULES.some((module) => isWithin(owner.path, `src/${module}`)));

  return allowed ? [] : [`unreachable module: ${ENTRY} ${verb} ${file} (${owner.name})`];
}

interface Owner {
  readonly name: string;
  readonly path: string;
}

function findPackage(file: string): Owner | undefined {
  const rule = PACKAGE_RULES.find((candidate) => file.startsWith(`${candidate.dir}/`));

  if (rule === undefined) {
    return undefined;
  }

  return { name: rule.name, path: file.slice(rule.dir.length + 1) };
}

function isWithin(path: string, module: string): boolean {
  return module.endsWith('/') ? path.startsWith(module) : path === module;
}

const APP_SOURCE = 'packages/app/src';

// A hook or statusline command starts once per event inside a session, and
// cli.ts's static imports load before every subcommand, so none of these may
// load a module whose top-level code builds schemas, the protocol contract, or the store.
const REPORTER_ENTRIES = [
  'cli.ts',
  'hook-report.ts',
  'note.ts',
  'tap.ts',
  'run-bridge-tap.ts',
  'statusline.ts',
].map((file) => `${APP_SOURCE}/${file}`);

// The folders under src/ that a reporter may load, by package name: a light
// root entry allows every folder but its heavy ones, such as core's schema
// entry, which loads Zod. Every other package stays out of a reporter's reach.
type ReporterAllowance = readonly string[] | { readonly except: readonly string[] };

const REPORTER_FOLDERS: ReadonlyMap<string, ReporterAllowance> = new Map<string, ReporterAllowance>(
  [
    ['core', { except: ['schema'] }],
    ['protocol', ['session', 'wire']],
    ['config', ['host', 'claude-statusline']],
    ['lifecycle', ['run-command']],
  ],
);

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

      // Type-only and dynamic imports load nothing at start-up
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

function isReporterLoadable(file: string): boolean {
  if (file.startsWith(`${APP_SOURCE}/`)) {
    return true;
  }

  const owner = findPackage(file);

  if (owner === undefined || !owner.path.startsWith('src/')) {
    return false;
  }

  const folders = REPORTER_FOLDERS.get(owner.name) ?? [];
  const path = owner.path.slice('src/'.length);

  if ('except' in folders) {
    return !folders.except.some((folder) => path.startsWith(`${folder}/`));
  }

  return folders.some((folder) => path.startsWith(`${folder}/`));
}

interface Reach {
  readonly files: ReadonlySet<string>;
  readonly unresolved: readonly string[];
}

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

// Null when the specifier names no workspace file that exists, undefined when
// it names an external package or a non-source file
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

// A path to a non-source file, such as a package.json, resolves to undefined:
// the walk follows source modules only
function findModule(known: ReadonlySet<string>, base: string): string | null | undefined {
  const path = base.replace(/\.js$/u, '');

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

// The bundle catches a reach that the source walk cannot read
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
