// Moves the files that one wave of the package migration moves, as the stage
// and test maps in scripts/package-map give them: each file goes from its
// path in the wave before to its path in this wave. Then it rewrites every
// relative import, in the moved files and in every other source file, that
// names a moved file or that a move changed. An import that crosses into
// another workspace package becomes that package's entry, such as
// `@atc/test-utils/wait-for`, when the package exports one; otherwise it
// stays a relative path, which check-manifests reports. A path the map holds
// in parentheses or as `-` belongs to a ticket, not to the codemod. A second
// run finds every file at its new path and changes nothing. Path literals
// that are not import specifiers are left for the move's author. Each
// `--package <name>` limits the move to the files that land in that package,
// so a wave that several tickets share moves one ticket's package at a time.
// A file that would leave the app while it imports a module that stays there
// waits for a later run, and so does each file that imports it, until no
// move leaves an import behind in the app. A test may still reach into the
// app, so a test waits only for a module of the move that waits.
// Usage: bun scripts/run-wave-move.ts <wave> [root] [--package <name>]...
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve } from 'node:path';
import { SyntaxKind } from 'typescript/unstable/ast';
import { z } from 'zod';
import { collectSourceFiles } from './collect-source-files';
import type { Token } from './collect-tokens';
import { collectTokens } from './collect-tokens';
import { PACKAGE_RULES } from './package-rules';

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const wave = Number(args.positionals[0]);
  const root = resolve(args.positionals[1] ?? join(import.meta.dir, '..'));

  if (!Number.isInteger(wave) || wave < 1) {
    throw new Error(USAGE);
  }

  const files = SOURCE_DIRS.flatMap((dir) => collectSourceFiles(root, dir));
  const planned = collectMoves(root, wave, args.packageDirs);

  const known = new Set([...files, ...planned.keys()]);

  const moves = collectReadyMoves(root, planned, known);
  const entries = collectEntries(root);
  let rewritten = 0;

  for (const file of files) {
    const target = moves.get(file) ?? file;
    const source = readFileSync(join(root, file), 'utf8');
    const updated = buildMovedSource(source, file, target, { moves, known, entries });

    if (target !== file) {
      mkdirSync(dirname(join(root, target)), { recursive: true });
      renameSync(join(root, file), join(root, target));
    }

    if (updated !== source) {
      writeFileSync(join(root, target), updated);

      rewritten += 1;
    }
  }

  const moved = files.filter((file) => moves.has(file)).length;
  const held = [...planned.keys()].filter((file) => !moves.has(file));

  console.log(`run-wave-move: wave ${wave}, ${moved} files moved, ${rewritten} files rewritten`);

  for (const file of held) {
    console.log(`held: ${file} imports a module that stays in packages/app`);
  }
}

const APP_DIR = 'packages/app/';

/**
 * The planned moves less every file that would leave the app while one of
 * its relative imports stays there, repeated until a pass holds nothing
 * more, since a held file keeps its importers in the app too.
 */
function collectReadyMoves(
  root: string,
  planned: ReadonlyMap<string, string>,
  known: ReadonlySet<string>,
): Map<string, string> {
  const ready = new Map(planned);

  for (let changed = true; changed; ) {
    changed = false;

    for (const [file, target] of ready) {
      const source = readFileSync(join(root, file), 'utf8');
      const imports = collectRelativeImports(source, file, known);

      // a test may reach into the app, so only a held module holds it
      const isBlocked =
        !target.startsWith(APP_DIR) &&
        (file.endsWith('.test.ts')
          ? imports.some((imported) => planned.has(imported) && !ready.has(imported))
          : imports.some((imported) => (ready.get(imported) ?? imported).startsWith(APP_DIR)));

      if (isBlocked) {
        ready.delete(file);

        changed = true;
      }
    }
  }

  return ready;
}

// The files a source's relative specifiers name, among the known files.
function collectRelativeImports(
  source: string,
  file: string,
  known: ReadonlySet<string>,
): string[] {
  const tokens = collectTokens(source);

  return [...tokens.entries()]
    .filter(([i, token]) => isSpecifierToken(tokens, i) && token.value.startsWith('.'))
    .map(([, token]) => findModule(known, file, token.value))
    .filter((imported) => imported !== null);
}

const USAGE = 'usage: run-wave-move.ts <wave> [root] [--package <name>]...';

interface WaveMoveArgs {
  readonly positionals: readonly string[];

  // the directories of the packages the move is limited to; empty moves
  // every package
  readonly packageDirs: readonly string[];
}

function parseArgs(argv: readonly string[]): WaveMoveArgs {
  const positionals: string[] = [];
  const packageDirs: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';

    if (arg === '--package') {
      const name = argv[i + 1];
      const rule = PACKAGE_RULES.find((candidate) => candidate.name === name);

      if (rule === undefined) {
        throw new Error(`unknown package: ${name ?? '(none)'}; ${USAGE}`);
      }

      packageDirs.push(rule.dir);

      i += 1;
    } else {
      positionals.push(arg);
    }
  }

  return { positionals, packageDirs };
}

// src/ holds the sources that wave 1 moves into packages/app
const SOURCE_DIRS = ['src', 'packages', 'e2e', 'scripts'];
const MAP_DIR = 'scripts/package-map';

// Each map table and the column that holds a file's path before wave 1.
const MAP_TABLES = [
  ['package-stagemap.tsv', 'source'],
  ['package-testmap.tsv', 'test'],
] as const;

/**
 * Each path this wave moves a file from, keyed to the path it moves to, for
 * the files that land in one of the given package directories, or in any
 * package when none is given. A file already at its new path is no longer a
 * move.
 */
function collectMoves(
  root: string,
  wave: number,
  packageDirs: readonly string[],
): Map<string, string> {
  const moves = new Map<string, string>();

  const to = `path_wave${wave}`;

  for (const [table, original] of MAP_TABLES) {
    const from = wave === 1 ? original : `path_wave${wave - 1}`;

    for (const row of readTable(join(root, MAP_DIR, table))) {
      const before = row[from] ?? '';
      const after = row[to] ?? '';

      const isSelected =
        packageDirs.length === 0 || packageDirs.some((dir) => after.startsWith(`${dir}/`));

      if (isSelected && isPlainPath(before) && isPlainPath(after) && before !== after) {
        if (existsSync(join(root, before))) {
          moves.set(before, after);
        } else if (!existsSync(join(root, after))) {
          throw new Error(`neither ${before} nor ${after} exists`);
        }
      }
    }
  }

  return moves;
}

function isPlainPath(path: string): boolean {
  return path !== '' && path !== '-' && !path.startsWith('(');
}

function readTable(path: string): Record<string, string>[] {
  const [header = '', ...lines] = readFileSync(path, 'utf8').trimEnd().split('\n');
  const columns = header.split('\t');

  return lines.map((line) => {
    const cells = line.split('\t');

    return Object.fromEntries(columns.map((column, i) => [column, cells[i] ?? '']));
  });
}

// A workspace package's directory, its name, and its wildcard entry, such as
// `./*` exporting `./src/*.ts`.
interface PackageEntry {
  readonly dir: string;
  readonly name: string;
  readonly prefix: string;
  readonly suffix: string;
}

const MANIFEST_SCHEMA = z.object({
  name: z.string().optional(),
  exports: z.record(z.string(), z.string()).optional(),
});

function collectEntries(root: string): PackageEntry[] {
  const entries: PackageEntry[] = [];

  for (const path of new Bun.Glob('packages/**/package.json').scanSync({ cwd: root })) {
    if (path.split('/').includes('node_modules')) {
      continue;
    }

    const text = readFileSync(join(root, path), 'utf8');
    const manifest = MANIFEST_SCHEMA.parse(JSON.parse(text));
    const target = manifest.exports?.['./*'];
    const [prefix, suffix] = target?.split('*') ?? [];

    if (manifest.name !== undefined && prefix !== undefined && suffix !== undefined) {
      entries.push({ dir: dirname(path), name: manifest.name, prefix: prefix.slice(2), suffix });
    }
  }

  return entries;
}

interface RewriteContext {
  readonly moves: ReadonlyMap<string, string>;
  readonly known: ReadonlySet<string>;
  readonly entries: readonly PackageEntry[];
}

/**
 * The source with each relative specifier pointed at its target's new path,
 * as seen from the file's new path.
 */
function buildMovedSource(
  source: string,
  file: string,
  target: string,
  ctx: RewriteContext,
): string {
  const tokens = collectTokens(source);
  let updated = source;

  // from the end, so each edit leaves the earlier offsets in place
  for (const [i, token] of [...tokens.entries()].toReversed()) {
    const imported =
      isSpecifierToken(tokens, i) && token.value.startsWith('.')
        ? findModule(ctx.known, file, token.value)
        : null;

    if (imported !== null) {
      const next = buildSpecifier(
        target,
        ctx.moves.get(imported) ?? imported,
        token.value,
        ctx.entries,
      );

      const quote = token.text[0] ?? "'";

      updated =
        updated.slice(0, token.start) +
        quote +
        next +
        quote +
        updated.slice(token.start + token.text.length);
    }
  }

  return updated;
}

/**
 * Whether token i is the specifier of an import, an export, or an
 * `import(...)` or `require(...)` call, rather than any other string.
 */
function isSpecifierToken(tokens: readonly Token[], i: number): boolean {
  const token = tokens[i];
  const previous = tokens[i - 1]?.kind;

  if (token?.kind !== SyntaxKind.StringLiteral) {
    return false;
  }

  if (previous === SyntaxKind.FromKeyword || previous === SyntaxKind.ImportKeyword) {
    return true;
  }

  const callee = tokens[i - 2]?.kind;

  return (
    previous === SyntaxKind.OpenParenToken &&
    (callee === SyntaxKind.ImportKeyword || callee === SyntaxKind.RequireKeyword) &&
    tokens[i - 3]?.kind !== SyntaxKind.DotToken
  );
}

function findModule(known: ReadonlySet<string>, file: string, specifier: string): string | null {
  const dir = dirname(file);
  const base = normalize(join(dir, specifier));

  return [base, `${base}.ts`, `${base}/index.ts`].find((candidate) => known.has(candidate)) ?? null;
}

/**
 * The specifier that names `imported` from `file`: a package entry when the
 * two sit in different packages and the imported one exports the file, else
 * a relative path written in the original specifier's style.
 */
function buildSpecifier(
  file: string,
  imported: string,
  original: string,
  entries: readonly PackageEntry[],
): string {
  const entry = entries.find((candidate) => imported.startsWith(`${candidate.dir}/`));
  const isOtherPackage = entry !== undefined && !file.startsWith(`${entry.dir}/`);
  const local = entry === undefined ? null : imported.slice(entry.dir.length + 1);

  if (
    isOtherPackage &&
    local !== null &&
    local.startsWith(entry.prefix) &&
    local.endsWith(entry.suffix)
  ) {
    return `${entry.name}/${local.slice(entry.prefix.length, local.length - entry.suffix.length)}`;
  }

  // an import of a folder's index names the folder
  const module = original.endsWith('.ts') ? imported : imported.replace(/(?:\/index)?\.ts$/u, '');
  const dir = dirname(file);
  const path = relative(dir, module);

  return path.startsWith('.') ? path : `./${path}`;
}

main();
