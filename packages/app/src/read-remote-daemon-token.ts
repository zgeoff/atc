import { readFileSync } from 'node:fs';
import type { RemoteDaemon } from '@atc/config';

// How long a token command may run before the read gives up on it.
const TOKEN_COMMAND_TIMEOUT_MS = 10_000;

/**
 * Reads a remote daemon's bearer token from the file or the command its
 * config entry holds, trimmed of surrounding whitespace. The token must be
 * one non-empty line. A failure rejects with a message that holds the
 * daemon's name and the token's source, never the token or the command's
 * output.
 */
export async function readRemoteDaemonToken(daemon: RemoteDaemon): Promise<string> {
  const source = daemon.token;

  const text =
    source.kind === 'file'
      ? readTokenFile(daemon.name, source.path)
      : await readTokenCommand(daemon.name, source.argv);

  const token = text.trim();

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

async function readTokenCommand(name: string, argv: readonly string[]): Promise<string> {
  let proc: Bun.Subprocess<'ignore', 'pipe', 'ignore'>;

  try {
    proc = Bun.spawn([...argv], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
      timeout: TOKEN_COMMAND_TIMEOUT_MS,
    });
  } catch (error) {
    throw new Error(`daemon '${name}': cannot run its token command ${argv[0]}`, { cause: error });
  }

  const [text, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

  if (exitCode !== 0) {
    const how =
      proc.signalCode === null ? `exited ${exitCode}` : `was killed by ${proc.signalCode}`;

    throw new Error(`daemon '${name}': its token command ${argv[0]} ${how}`);
  }

  return text;
}

function formatTokenSource(daemon: RemoteDaemon): string {
  return daemon.token.kind === 'file'
    ? `its token file ${daemon.token.path}`
    : `the output of its token command ${daemon.token.argv[0]}`;
}
