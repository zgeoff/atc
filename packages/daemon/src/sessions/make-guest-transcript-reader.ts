import type { ExecutionProvider } from '@atc/plugin-api';
import type { ReadTranscriptWindow } from './load-transcript-page';

// The exit code of READ_TRANSCRIPT_WINDOW_SCRIPT when the host holds no file at the path.
const NO_TRANSCRIPT_CODE = 3;

// Prints the size of the file at $1 on one line, then $3 bytes of it from the
// offset $2 in base64, since a command's output reaches the daemon as text.
export const READ_TRANSCRIPT_WINDOW_SCRIPT = `[ -f "$1" ] || exit ${NO_TRANSCRIPT_CODE}
wc -c < "$1" && tail -c +"$(($2 + 1))" "$1" | head -c "$3" | base64 -w0`;

export function makeGuestTranscriptReader(
  provider: Pick<ExecutionProvider, 'runCommand'>,
  host: string,
): ReadTranscriptWindow {
  return async (path, offset, length) => {
    const read = await provider.runCommand({
      argv: ['sh', '-c', READ_TRANSCRIPT_WINDOW_SCRIPT, 'sh', path, String(offset), String(length)],
      cwd: '/',
      host,
    });

    if (read.exitCode === NO_TRANSCRIPT_CODE) {
      return null;
    }

    const newline = read.stdout.indexOf('\n');
    const size = Number(read.stdout.slice(0, newline).trim());

    if (read.exitCode !== 0 || newline === -1 || !Number.isSafeInteger(size)) {
      throw new Error(`reading ${path} on host ${host} failed: ${read.stderr.trim()}`);
    }

    return { size, bytes: Buffer.from(read.stdout.slice(newline + 1), 'base64') };
  };
}
