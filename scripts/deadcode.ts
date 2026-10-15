// Checks the working directory for dead code with this checkout's knip, run
// under the Bun that runs this script, so the patched knip that starts its
// tsconfig search inside the working directory is the one that runs. Passes
// its arguments through to knip and exits with knip's exit code.
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
