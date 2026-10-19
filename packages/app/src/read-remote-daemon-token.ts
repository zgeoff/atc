import { readFileSync } from 'node:fs';
import type { RemoteDaemon } from '@atc/config';
import { runCommand } from '@atc/lifecycle/run-command';

// How long a token command may run before the read gives up on it.
const TOKEN_COMMAND_TIMEOUT_MS = 10_000;

interface TokenReadOptions {
  // How long a token command may take, its output and its exit together.
  readonly timeoutMs?: number;
}

export async function readRemoteDaemonToken(
  daemon: RemoteDaemon,
  options: TokenReadOptions = {},
): Promise<string> {
  const source = daemon.token;

  const text =
    source.kind === 'file'
      ? readTokenFile(daemon.name, source.path)
      : await readTokenCommand(
          daemon.name,
          source.argv,
          options.timeoutMs ?? TOKEN_COMMAND_TIMEOUT_MS,
        );

  const token = text.trim();

  // a failure names the daemon and the token's source, never the token or the
  // command's output
  if (token === '' || token.includes('\n')) {
    throw new Error(
      `daemon '${daemon.name}': ${formatTokenSource(daemon)} must hold one token on one line`,
    );
  }

  return token;
}

function readTokenFile(name: string, path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    const code: unknown = error instanceof Error ? Reflect.get(error, 'code') : undefined;

    throw new Error(
      `daemon '${name}': cannot read its token file ${path} (${typeof code === 'string' ? code : 'unreadable'})`,
      { cause: error },
    );
  }
}

async function readTokenCommand(
  name: string,
  argv: readonly string[],
  timeoutMs: number,
): Promise<string> {
  // One deadline covers the output and the exit, and stops the whole process
  // group, so a child that holds stdout open cannot hold the read. A child can
  // also hold stderr open after the token prints, so the read ignores stderr.
  const result = await runCommand(argv, {
    signal: AbortSignal.timeout(timeoutMs),
    stderr: 'ignore',
  });

  if (result.aborted) {
    throw new Error(`daemon '${name}': its token command ${argv[0]} ran past ${timeoutMs} ms`);
  }

  // A command that cannot start reads as exit code 127, as a shell reports it.
  if (result.code === 127) {
    throw new Error(`daemon '${name}': cannot run its token command ${argv[0]}`);
  }

  if (result.code !== 0) {
    throw new Error(`daemon '${name}': its token command ${argv[0]} exited ${result.code}`);
  }

  return result.stdout;
}

function formatTokenSource(daemon: RemoteDaemon): string {
  return daemon.token.kind === 'file'
    ? `its token file ${daemon.token.path}`
    : `the output of its token command ${daemon.token.argv[0]}`;
}
