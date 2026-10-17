// Runs this checkout's knip under the Bun that runs this script, so the
// patched knip that starts its tsconfig search inside the working directory
// is the one that runs.
import { join } from 'node:path';

async function main(): Promise<void> {
  const knip = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, '..', 'node_modules', '.bin', 'knip'),
      ...process.argv.slice(2),
    ],
    { stdio: ['inherit', 'inherit', 'inherit'] },
  );

  const exitCode = await knip.exited;

  process.exit(exitCode);
}

await main();
