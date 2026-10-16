// Fails on a raw ESC byte (0x1B) in a source module. An editor shows the byte
// as nothing or as a lookalike, a diff can drop it, and oxlint passes it, so
// the escape sequences the TUI writes stay legible only as `\u001B` escapes.
// Prints each byte's file, line, and column, and exits 1 when it finds one.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { collectSourceFiles } from './collect-source-files';

function main(): void {
  const root = resolve(process.argv[2] ?? join(import.meta.dir, '..'));

  const found = SOURCE_DIRS.flatMap((dir) => collectSourceFiles(root, dir)).flatMap((file) =>
    collectRawEscapes(readFileSync(join(root, file), 'utf8')).map(
      (position) => `${file}:${position}`,
    ),
  );

  for (const position of found) {
    console.error(`raw ESC byte: ${position}; write it as \\u001B`);
  }

  console.log(`check-raw-escapes: ${found.length} raw ESC bytes`);

  if (found.length > 0) {
    process.exit(1);
  }
}

const SOURCE_DIRS = ['packages', 'e2e', 'scripts', 'mods'];
const ESC = String.fromCodePoint(0x1b);

/**
 * The `line:column` of each raw ESC byte in the source, both 1-based.
 */
function collectRawEscapes(source: string): string[] {
  return source
    .split('\n')
    .flatMap((line, index) =>
      [...line.matchAll(new RegExp(ESC, 'g'))].map((match) => `${index + 1}:${match.index + 1}`),
    );
}

main();
