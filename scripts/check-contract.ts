import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DECLARATION_TOOLS } from './declaration-tools';
import { writeContractDeclarations } from './write-contract-declarations';

async function main(): Promise<void> {
  const args = parseArgs({
    args: process.argv.slice(2),
    options: {
      update: { type: 'boolean', default: false },
      package: { type: 'string', multiple: true, default: PACKAGES },
    },
    allowPositionals: true,
  });

  const root = resolve(args.positionals[0] ?? join(import.meta.dir, '..'));

  for (const name of args.values.package) {
    await checkPackage(root, name, args.values.update);
  }
}

async function checkPackage(root: string, name: string, update: boolean): Promise<void> {
  const out = mkdtempSync(join(tmpdir(), 'check-contract-'));
  const packageDir = `packages/${name}`;
  const snapshot = `${packageDir}/declarations.snap`;

  try {
    const files = await writeContractDeclarations(root, out, DECLARATION_TOOLS, packageDir);

    const rendered = readSnapshot(files, (file) => readFileSync(join(out, file), 'utf8'));
    const path = join(root, snapshot);

    if (update) {
      writeFileSync(path, rendered);

      console.log(`check-contract: wrote ${files.length} declaration files to ${snapshot}`);

      return;
    }

    const committed = existsSync(path) ? readFileSync(path, 'utf8') : '';
    const line = findFirstDifference(committed, rendered);

    if (line !== undefined) {
      console.error(
        `stale snapshot: ${snapshot} differs from the emitted declarations at line ${line}; run bun run check:contract --update and review the diff`,
      );

      // process.exit would skip the cleanup that removes the declarations
      process.exitCode = 1;

      return;
    }

    console.log(`check-contract: ${files.length} declaration files match ${snapshot}`);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

// The published packages, each with its own snapshot of the declarations it ships.
const PACKAGES = ['contract', 'client'];

function readSnapshot(files: readonly string[], readText: (file: string) => string): string {
  return files.map((file) => `// ${file}\n${readText(file)}`).join('\n');
}

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
