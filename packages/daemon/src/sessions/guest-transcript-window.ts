import { z } from 'zod';
import type { TranscriptWindow } from './load-transcript-page';

export const NO_TRANSCRIPT_CODE = 3;

// dd's POSIX options skip and count only whole blocks, and GNU's byte offsets are missing on macOS.
const BLOCK_BYTES = 65_536;

// GNU base64 wraps its output and macOS's does not, so the blocks come last and may span lines.
const RESPONSE_FIELDS = [
  { name: 'size', value: '"$((size))"', pattern: String.raw`\d+` },
  { name: 'blocks', value: '"$blocks"', pattern: String.raw`[\d+/=A-Za-z\n]*` },
] as const;

type ResponseField = (typeof RESPONSE_FIELDS)[number]['name'];

const RESPONSE_PATTERN = new RegExp(
  `^${RESPONSE_FIELDS.map((field) => `(?<${field.name}>${field.pattern})`).join(String.raw`\n`)}\n$`,
  'u',
);

const RESPONSE_SCHEMA = z.object({
  size: z.string().transform(Number).pipe(z.number().int().nonnegative()),
  blocks: z.string().transform((blocks) => Buffer.from(blocks.replaceAll('\n', ''), 'base64')),
} satisfies Record<ResponseField, z.ZodType>);

// dd copies the blocks to a file first, since a pipeline exits with its last command's status and
// a reader before it that stops early, such as tail before head, ends on a broken pipe.
export const READ_TRANSCRIPT_WINDOW_SCRIPT = `[ -f "$1" ] || exit ${NO_TRANSCRIPT_CODE}
size=$(wc -c < "$1") || exit 1
window=$(mktemp) || exit 1
trap 'rm -f "$window"' EXIT
dd if="$1" of="$window" bs=${BLOCK_BYTES} skip="$2" count="$3" || exit 1
blocks=$(base64 < "$window") || exit 1
printf '${RESPONSE_FIELDS.map(() => '%s').join(String.raw`\n`)}\\n' ${RESPONSE_FIELDS.map((field) => field.value).join(' ')}`;

export function buildTranscriptWindowArgs(
  path: string,
  offset: number,
  length: number,
): readonly string[] {
  const first = Math.floor(offset / BLOCK_BYTES);
  const end = Math.ceil((offset + length) / BLOCK_BYTES);

  return [path, String(first), String(end - first)];
}

export function parseTranscriptWindow(
  stdout: string,
  offset: number,
  length: number,
): TranscriptWindow | null {
  const parsed = RESPONSE_SCHEMA.safeParse(RESPONSE_PATTERN.exec(stdout)?.groups);

  if (!parsed.success) {
    return null;
  }

  const start = offset % BLOCK_BYTES;

  return { size: parsed.data.size, bytes: parsed.data.blocks.subarray(start, start + length) };
}
