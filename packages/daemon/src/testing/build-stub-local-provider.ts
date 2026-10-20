import { mkdir } from 'node:fs/promises';
import { buildStubMemoryProvider } from './build-stub-memory-provider';
import type { StubMemoryProvider } from './build-stub-memory-provider';
import { runLocalCommand } from './run-local-command';

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

async function transferLocalArchive(archive: Uint8Array, directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });

  // an inherited TAR_OPTIONS would change how tar unpacks
  const { TAR_OPTIONS: _ignored, ...env } = process.env;

  const subprocess = Bun.spawn(['tar', '-x', '-f', '-', '-C', directory], {
    cwd: directory,
    env,
    stdin: archive,
    stdout: 'ignore',
    stderr: 'pipe',
  });

  const [stderr, exitCode] = await Promise.all([
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);

  if (exitCode !== 0) {
    throw new Error(`tar exited ${exitCode} unpacking into ${directory}: ${stderr}`);
  }
}
