import { z } from 'zod';
import type { TranscriptWindow } from './load-transcript-page';

// The exit code of READ_TRANSCRIPT_WINDOW_SCRIPT when the host holds no file at the path.
export const NO_TRANSCRIPT_CODE = 3;

// dd's POSIX options skip and count only whole blocks, and GNU's byte offsets are missing on macOS.
const BLOCK_BYTES = 65_536;

// Prints the file's size and $3 blocks of the file at $1 from block $2. dd copies the blocks to a
// file first, since a pipeline exits with its last command's status and a reader before it that
// stops early, such as tail before head, ends on a broken pipe.
export const READ_TRANSCRIPT_WINDOW_SCRIPT = `[ -f "$1" ] || exit ${NO_TRANSCRIPT_CODE}
size=$(wc -c < "$1") || exit 1
window=$(mktemp) || exit 1
trap 'rm -f "$window"' EXIT
dd if="$1" of="$window" bs=${BLOCK_BYTES} skip="$2" count="$3" || exit 1
printf '%s\\n' "$((size))" && base64 < "$window"`;

// The file's size on one line, then the blocks in base64, since a command's output reaches the
// daemon as text. GNU base64 wraps its output and macOS's does not.
const TRANSCRIPT_BLOCKS_RESPONSE = z
  .string()
  .regex(/^\d+\n[\d+/=A-Za-z\n]*$/u)
  .transform((stdout) => {
    const newline = stdout.indexOf('\n');

    return {
      size: Number(stdout.slice(0, newline)),
      blocks: Buffer.from(stdout.slice(newline + 1).replaceAll('\n', ''), 'base64'),
    };
  })
  .refine((response) => Number.isSafeInteger(response.size));

export function buildTranscriptWindowArgs(
  path: string,
  offset: number,
  length: number,
): readonly string[] {
  const first = Math.floor(offset / BLOCK_BYTES);
  const end = Math.ceil((offset + length) / BLOCK_BYTES);

  return [path, String(first), String(end - first)];
}

// Takes the bytes the arguments of the same offset and length asked for out of the whole blocks.
export function parseTranscriptWindow(
  stdout: string,
  offset: number,
  length: number,
): TranscriptWindow | null {
  const parsed = TRANSCRIPT_BLOCKS_RESPONSE.safeParse(stdout);

  if (!parsed.success) {
    return null;
  }

  const start = offset % BLOCK_BYTES;

  return { size: parsed.data.size, bytes: parsed.data.blocks.subarray(start, start + length) };
}
