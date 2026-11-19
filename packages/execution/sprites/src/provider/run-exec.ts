import { SpritesApiError } from '../port/sprites-api-error';
import type { ExecEnd, ExecRequest, SpritesPort } from '../port/types';
import { waitOut } from '../port/wait-out';

export interface ExecResult {
  readonly exitCode: number;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
}

const STDIN_CHUNK = 64 * 1024;

// Runs a command in a sprite to its exit, with the bytes as its stdin. Rejects when the
// connection ends before the exit.
export async function runExec(
  api: SpritesPort,
  sprite: string,
  request: Omit<ExecRequest, 'tty'>,
  stdin: Uint8Array = new Uint8Array(),
): Promise<ExecResult> {
  const connection = api.openExec(sprite, { ...request, tty: false });
  const stdout: Uint8Array[] = [];
  const stderr: Uint8Array[] = [];
  const ended = Promise.withResolvers<ExecEnd>();

  void waitOut(connection.execID);

  connection.onData((data, stream) => {
    (stream === 'stdout' ? stdout : stderr).push(data);
  });

  connection.onEnd((end) => {
    ended.resolve(end);
  });

  try {
    for (let offset = 0; offset < stdin.length; offset += STDIN_CHUNK) {
      await connection.write(stdin.subarray(offset, offset + STDIN_CHUNK));
    }
  } catch (error) {
    connection.detach();
    throw error;
  }

  connection.endInput();

  const end = await ended.promise;

  if (end.kind === 'dropped') {
    throw new SpritesApiError(null, `a command on sprite ${sprite} lost its connection`);
  }

  return { exitCode: end.exitCode, stdout: join(stdout), stderr: join(stderr) };
}

function join(chunks: readonly Uint8Array[]): Uint8Array {
  return new Uint8Array(Buffer.concat(chunks));
}
