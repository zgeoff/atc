// Migrates a state database at the path given, which the test script copies
// for each test that opens one.
// Usage: bun scripts/create-state-template.ts <path>
import { createStateStore } from '@atc/store';

async function main(): Promise<void> {
  const path = process.argv[2] ?? null;

  if (path === null) {
    console.error('usage: bun scripts/create-state-template.ts <path>');
    process.exit(2);
  }

  const store = await createStateStore(path);

  await store.stop();
}

await main();
