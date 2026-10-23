// Checks what the atc-gateway entry can reach. The gateway binary must never
// start a daemon or run a session on its own machine, so nothing it imports,
// type-only imports included, may belong to a package outside its allowance.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, normalize, resolve } from 'node:path';
import { SyntaxKind } from 'typescript/unstable/ast';
import { z } from 'zod';
import { collectImports } from './collect-imports';
import { collectTokens } from './collect-tokens';
import { readSourceFiles } from './read-source-files';

async function main(): Promise<void> {
  const root = resolve(process.argv[2] ?? join(import.meta.dir, '..'));

  const known = new Set(readSourceFiles(root, 'packages'));

  const exports = readExports(root);

  const reached = collectReached(
    known,
    exports,
    [ENTRY],
    (file) => collectImports(readFileSync(join(root, file), 'utf8')).specifiers,
  );

  const bundled = await readBundled(root, ENTRY);

  const findings = [
    ...[...reached.files].toSorted().flatMap((file) => checkFile('reaches', file)),
    ...reached.unresolved,
    ...bundled
      .filter((file) => known.has(file))
      .toSorted()
      .flatMap((file) => checkFile('bundles', file)),
    ...checkReporters(root, known, exports),
    ...checkDaemon(root, known, exports),
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
  'run-command-line.ts',
  'run-gateway.ts',
  'open-mcp-auth-database.ts',
  'clients.ts',
  'passkeys.ts',
  'create-clients-command.ts',
  'create-passkeys-command.ts',
  'process-io.ts',
];

function checkFile(verb: string, file: string): string[] {
  const owner = findPackage(file);

  if (owner === undefined) {
    return [`unowned module: ${ENTRY} ${verb} ${file}, which sits in no package's src/ folder`];
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

// A package's directory under packages/ is the part of a path before its
// src/ folder, and its name here is that directory without the packages/
// prefix, such as `core` or `harnesses/claude`.
function findPackage(file: string): Owner | undefined {
  const match = /^packages\/(?<name>.+?)\/(?<path>src\/.+)$/u.exec(file);
  const name = match?.groups?.['name'];
  const path = match?.groups?.['path'];

  return name === undefined || path === undefined ? undefined : { name, path };
}

function isWithin(path: string, module: string): boolean {
  return module.endsWith('/') ? path.startsWith(module) : path === module;
}

const APP_SOURCE = 'packages/app/src';

// A hook or statusline command starts once per event inside a session, and
// cli.ts's static imports load before every subcommand, so none of these may
// load a module whose top-level code builds schemas, the protocol contract, or the store.
const REPORTER_ENTRIES = [
  `${APP_SOURCE}/cli.ts`,
  'packages/reporters/src/index.ts',
  'packages/reporters/src/tap/index.ts',
];

// The folders under src/ that a reporter may load, by package name: a light
// root entry allows every folder but its heavy ones, such as core's schema
// entry, which loads Zod. Every other package stays out of a reporter's reach.
type ReporterAllowance = readonly string[] | { readonly except: readonly string[] };

const REPORTER_FOLDERS: ReadonlyMap<string, ReporterAllowance> = new Map<string, ReporterAllowance>(
  [
    ['core', { except: ['schema'] }],
    ['reporters', { except: [] }],
    ['protocol', ['client', 'session', 'wire']],
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

// The daemon package's entry points: its main entry and the test helpers it
// exports, which other packages' tests load.
const DAEMON_ENTRIES: readonly string[] = [
  'packages/daemon/src/index.ts',
  'packages/daemon/src/testing/index.ts',
];

// The modules the daemon must never reach: the opener of the gateway's
// authorization database, mcp-auth.db.
const DAEMON_REFUSED_MODULES: readonly string[] = [`${APP_SOURCE}/open-mcp-auth-database.ts`];

// The names that lead to mcp-auth.db: its file name and the config path that
// holds it. A reached file that names either could open the database without
// the opener.
const AUTH_DB_NAMES: readonly string[] = ['mcp-auth.db', 'mcpAuthDBFile'];

// The config modules that define the mcp-auth.db path, the only files the
// daemon reaches that may name it.
const AUTH_DB_PATH_MODULES: ReadonlySet<string> = new Set([
  'packages/config/src/host/resolve-paths.ts',
  'packages/config/src/host/process-paths.ts',
]);

// The tokens that can hold a name: identifiers, strings, and template parts.
// A comment is no token, so a comment may name the database.
const NAME_TOKEN_KINDS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.Identifier,
  SyntaxKind.StringLiteral,
  SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.TemplateHead,
  SyntaxKind.TemplateMiddle,
  SyntaxKind.TemplateTail,
]);

// Per daemon entry: each refused module, each reached file that names
// mcp-auth.db, and each unresolved import. Beside the atc CLI entry, a missing
// daemon entry or refused module is a finding too.
function checkDaemon(
  root: string,
  known: ReadonlySet<string>,
  exports: ReadonlyMap<string, string>,
): string[] {
  const missing = existsSync(join(root, APP_SOURCE, 'cli.ts'))
    ? [...DAEMON_ENTRIES, ...DAEMON_REFUSED_MODULES]
        .filter((module) => !known.has(module))
        .map((module) => `missing daemon module: ${module} does not exist`)
    : [];

  const findings = [...missing];

  for (const entry of DAEMON_ENTRIES.filter((candidate) => known.has(candidate))) {
    const reached = collectReached(
      known,
      exports,
      [entry],
      (file) => collectImports(readFileSync(join(root, file), 'utf8')).specifiers,
    );

    for (const module of DAEMON_REFUSED_MODULES.filter((refused) => reached.files.has(refused))) {
      findings.push(
        `refused module: ${entry} reaches ${module}, which opens the gateway's mcp-auth.db`,
      );
    }

    for (const file of [...reached.files].toSorted()) {
      const line = AUTH_DB_PATH_MODULES.has(file)
        ? undefined
        : findAuthDBName(readFileSync(join(root, file), 'utf8'));

      if (line !== undefined) {
        findings.push(
          `named database: ${entry} reaches ${file}, which names the gateway's mcp-auth.db at line ${line}`,
        );
      }
    }

    findings.push(...reached.unresolved);
  }

  return findings;
}

// The 1-based line of the first token that names mcp-auth.db in any case,
// which a case-insensitive filesystem opens as the same file, or undefined.
function findAuthDBName(source: string): number | undefined {
  const token = collectTokens(source).find(
    (candidate) =>
      NAME_TOKEN_KINDS.has(candidate.kind) &&
      AUTH_DB_NAMES.some((name) => candidate.value.toLowerCase().includes(name.toLowerCase())),
  );

  return token === undefined ? undefined : source.slice(0, token.start).split('\n').length;
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
    const directory = dirname(file);

    return findModule(known, normalize(join(directory, specifier)));
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

function readExports(root: string): Map<string, string> {
  const exports = new Map<string, string>();

  for (const path of new Bun.Glob('packages/**/package.json').scanSync({ cwd: root })) {
    if (path.includes('node_modules')) {
      continue;
    }

    const text = readFileSync(join(root, path), 'utf8');
    const manifest = PACKAGE_MANIFEST_SCHEMA.parse(JSON.parse(text));

    for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
      const specifier = subpath === '.' ? manifest.name : `${manifest.name}/${subpath.slice(2)}`;
      const directory = dirname(path);

      if (specifier !== undefined) {
        exports.set(specifier, normalize(join(directory, target)));
      }
    }
  }

  return exports;
}

// The bundle catches a reach that the source walk cannot read
async function readBundled(root: string, entry: string): Promise<string[]> {
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
