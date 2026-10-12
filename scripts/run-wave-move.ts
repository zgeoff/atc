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
// that are not import specifiers are left for the move's author.
// Usage: bun scripts/run-wave-move.ts <wave> [root]
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve } from 'node:path';
import { SyntaxKind } from 'typescript/unstable/ast';
import { z } from 'zod';
import { collectSourceFiles } from './collect-source-files';
import type { Token } from './collect-tokens';
import { collectTokens } from './collect-tokens';

function main(): void {
  const wave = Number(process.argv[2]);
  const root = resolve(process.argv[3] ?? join(import.meta.dir, '..'));

  if (!Number.isInteger(wave) || wave < 1) {
    throw new Error('usage: run-wave-move.ts <wave> [root]');
  }

  const moves = collectMoves(root, wave);
  const files = SOURCE_DIRS.flatMap((dir) => collectSourceFiles(root, dir));

  const known = new Set([...files, ...moves.keys()]);

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

  console.log(`run-wave-move: wave ${wave}, ${moved} files moved, ${rewritten} files rewritten`);
}

// src/ holds the sources that wave 1 moves into packages/app
const SOURCE_DIRS = ['src', 'packages', 'e2e', 'scripts'];
const MAP_DIR = 'scripts/package-map';

/**
 * Each path this wave moves a file from, keyed to the path it moves to. A
 * file already at its new path is no longer a move.
 */
function collectMoves(root: string, wave: number): Map<string, string> {
  const moves = new Map<string, string>();

  const from = wave === 1 ? 'source' : `path_wave${wave - 1}`;
  const to = `path_wave${wave}`;

  for (const table of ['package-stagemap.tsv', 'package-testmap.tsv']) {
    for (const row of readTable(join(root, MAP_DIR, table))) {
      const before = row[from] ?? '';
      const after = row[to] ?? '';

      if (isPlainPath(before) && isPlainPath(after) && before !== after) {
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
  const module = original.endsWith('.ts') ? imported : imported.replace(/(?:\/index)?\.ts$/, '');
  const dir = dirname(file);
  const path = relative(dir, module);

  return path.startsWith('.') ? path : `./${path}`;
}

main();
