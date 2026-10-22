// Migrates a state database at the path given, which the test script copies
// for each test that opens one.
// Usage: bun scripts/create-state-template.ts <path>
import { parseArgs } from 'node:util';
import { createStateStore } from '@atc/store';

async function main(): Promise<void> {
  const path = parsePath(process.argv.slice(2));

  if (path === null) {
    console.error('usage: bun scripts/create-state-template.ts <path>');
    process.exit(2);
  }

  const store = await createStateStore(path);

  await store.stop();
}

// The one path the run gives, or null for a run with no path, a second one,
// or an option.
function parsePath(argv: readonly string[]): string | null {
  try {
    const args = parseArgs({ args: [...argv], options: {}, allowPositionals: true });
    const [path, ...extra] = args.positionals;

    return path !== undefined && extra.length === 0 ? path : null;
  } catch {
    return null;
  }
}

await main();
