import { chmodSync, readdirSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { runProgram } from './run-program';

// Bun reuses this copy of an embedded library. Two processes that find none can pick one
// scratch name in the same clock tick, and the loser passes dlopen the virtual /$bunfs path.
export function findPTYLibraryCopy(names: readonly string[], uid: number): string | undefined {
  return names.find(
    (name) =>
      name.startsWith(`.bun-${String(uid)}-`) && (name.endsWith('.so') || name.endsWith('.dylib')),
  );
}

function runInherited(argv: readonly string[]): void {
  const result = runProgram(argv, { cwd: process.cwd(), env: process.env });

  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);

  if (result.exitCode !== 0) {
    throw new Error(`${argv.join(' ')} exited with ${String(result.exitCode)}`);
  }
}

// One file of daemon tests starts its daemons one at a time, so its first daemon
// writes the copy alone, before the parallel suite starts many daemons at once.
function main(): void {
  try {
    const bin = process.env['ATC_BIN'];

    if (bin === undefined) {
      throw new Error('ATC_BIN is unset');
    }

    chmodSync(bin, 0o755);
    runInherited([bin, '--version']);
    runInherited(['bun', 'run', 'test:e2e', 'e2e/daemon-env.test.ts']);

    const directory = tmpdir();
    const copy = findPTYLibraryCopy(readdirSync(directory), userInfo().uid);

    if (copy === undefined) {
      throw new Error(
        `no copy of the PTY library in ${directory}, so the parallel daemons would each write one`,
      );
    }

    process.stdout.write(`copy-pty-library: ${join(directory, copy)}\n`);
  } catch (error) {
    process.stderr.write(
      `copy-pty-library: ${error instanceof Error ? error.message : String(error)}\n`,
    );

    process.exit(1);
  }
}

if (import.meta.main) {
  main();
}
