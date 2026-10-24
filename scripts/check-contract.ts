// Checks the declarations of @atcx/contract, the types its consumers compile
// against, against the committed snapshot, so a change to the published types
// shows in review. Usage: bun scripts/check-contract.ts [root] [--update]
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DECLARATION_TOOLS } from './declaration-tools';
import { writeContractDeclarations } from './write-contract-declarations';

async function main(): Promise<void> {
  const args = parseArgs({
    args: process.argv.slice(2),
    options: { update: { type: 'boolean', default: false } },
    allowPositionals: true,
  });

  const root = resolve(args.positionals[0] ?? join(import.meta.dir, '..'));
  const out = mkdtempSync(join(tmpdir(), 'check-contract-'));

  try {
    const files = await writeContractDeclarations(root, out, DECLARATION_TOOLS);

    const rendered = readSnapshot(out, files);
    const path = join(root, SNAPSHOT);

    if (args.values.update) {
      writeFileSync(path, rendered);

      console.log(`check-contract: wrote ${files.length} declaration files to ${SNAPSHOT}`);

      return;
    }

    const committed = existsSync(path) ? readFileSync(path, 'utf8') : '';
    const line = findFirstDifference(committed, rendered);

    if (line !== undefined) {
      console.error(
        `stale snapshot: ${SNAPSHOT} differs from the emitted declarations at line ${line}; run bun run check:contract --update and review the diff`,
      );

      // process.exit would skip the finally that removes the declarations
      process.exitCode = 1;

      return;
    }

    console.log(`check-contract: ${files.length} declaration files match ${SNAPSHOT}`);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

const SNAPSHOT = 'packages/contract/declarations.snap';

function readSnapshot(out: string, files: readonly string[]): string {
  return files.map((file) => `// ${file}\n${readFileSync(join(out, file), 'utf8')}`).join('\n');
}

// The 1-based number of the first line the two texts disagree on, or
// undefined when they are equal.
function findFirstDifference(committed: string, rendered: string): number | undefined {
  if (committed === rendered) {
    return undefined;
  }

  const committedLines = committed.split('\n');
  const renderedLines = rendered.split('\n');
  const index = renderedLines.findIndex((line, position) => line !== committedLines[position]);

  return (index === -1 ? renderedLines.length : index) + 1;
}

await main();
