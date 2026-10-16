import { mkdir } from 'node:fs/promises';
import { buildStubMemoryProvider } from './build-stub-memory-provider';
import type { StubMemoryProvider } from './build-stub-memory-provider';
import { runLocalCommand } from './run-local-command';

/**
 * An in-memory provider whose files and commands reach this machine as the
 * local provider's do: it reports the `local-pty` kind, runs each command
 * here, and unpacks each archive into its directory with tar, creating the
 * directory first and ignoring the `TAR_OPTIONS` the test inherited. A
 * failed unpack rejects with tar's exit code and error output. Harnesses
 * stay in memory, and the config overrides any default.
 */
export function buildStubLocalProvider(
  config: Parameters<typeof buildStubMemoryProvider>[0] = {},
): StubMemoryProvider {
  return buildStubMemoryProvider({
    kind: 'local-pty',
    runCommand: runLocalCommand,
    transferArchive: transferLocalArchive,
    ...config,
  });
}

async function transferLocalArchive(archive: Uint8Array, dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });

  const { TAR_OPTIONS: _ignored, ...env } = process.env;

  const proc = Bun.spawn(['tar', '-x', '-f', '-', '-C', dir], {
    cwd: dir,
    env,
    stdin: archive,
    stdout: 'ignore',
    stderr: 'pipe',
  });

  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);

  if (exitCode !== 0) {
    throw new Error(`tar exited ${exitCode} unpacking into ${dir}: ${stderr}`);
  }
}
