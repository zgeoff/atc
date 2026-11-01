import { chmodSync, readdirSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import type { RunProgram } from './run-program';
import { runProgram } from './run-program';

export interface CopyPTYLibraryOptions {
  readonly cwd: string;

  readonly env: Readonly<Record<string, string | undefined>>;

  // The daemons' TMPDIR, where Bun writes the copy.
  readonly tempDirectory: string;

  readonly uid: number;

  readonly runProgram: RunProgram;

  readonly writeStdout: (text: string) => void;

  readonly writeStderr: (text: string) => void;
}

// Bun reuses this copy of an embedded library. Two processes that find none can pick one
// scratch name in the same clock tick, and the loser passes dlopen the virtual /$bunfs path.
export function findPTYLibraryCopy(names: readonly string[], uid: number): string | undefined {
  return names.find(
    (name) =>
      name.startsWith(`.bun-${String(uid)}-`) && (name.endsWith('.so') || name.endsWith('.dylib')),
  );
}

// One file of daemon tests starts its daemons one at a time, so its first daemon writes the copy
// alone, before the parallel suite starts many daemons at once. Returns the exit code.
export function runCopyPTYLibrary(options: Readonly<CopyPTYLibraryOptions>): number {
  try {
    const bin = options.env['ATC_BIN'];

    if (bin === undefined) {
      throw new Error('ATC_BIN is unset');
    }

    chmodSync(bin, 0o755);
    runInherited(options, [bin, '--version']);
    runInherited(options, ['bun', 'run', 'test:e2e', 'e2e/daemon-env.test.ts']);

    const copy = findPTYLibraryCopy(readdirSync(options.tempDirectory), options.uid);

    if (copy === undefined) {
      throw new Error(
        `no copy of the PTY library in ${options.tempDirectory}, so the parallel daemons would each write one`,
      );
    }

    options.writeStdout(`copy-pty-library: ${join(options.tempDirectory, copy)}\n`);

    return 0;
  } catch (error) {
    options.writeStderr(
      `copy-pty-library: ${error instanceof Error ? error.message : String(error)}\n`,
    );

    return 1;
  }
}

function runInherited(options: Readonly<CopyPTYLibraryOptions>, argv: readonly string[]): void {
  const result = options.runProgram(argv, { cwd: options.cwd, env: options.env });

  options.writeStdout(result.stdout);
  options.writeStderr(result.stderr);

  if (result.exitCode !== 0) {
    throw new Error(`${argv.join(' ')} exited with ${String(result.exitCode)}`);
  }
}

if (import.meta.main) {
  process.exit(
    runCopyPTYLibrary({
      cwd: process.cwd(),
      env: process.env,
      tempDirectory: tmpdir(),
      uid: userInfo().uid,
      runProgram,
      writeStdout: (text) => {
        process.stdout.write(text);
      },
      writeStderr: (text) => {
        process.stderr.write(text);
      },
    }),
  );
}
