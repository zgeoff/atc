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
