import { z } from 'zod';
import { BLOCK_BYTES, RESPONSE_FIELDS } from './constants';
import type { TranscriptWindow } from './types';

type ResponseField = (typeof RESPONSE_FIELDS)[number]['name'];

const RESPONSE_PATTERN = new RegExp(
  `^${RESPONSE_FIELDS.map((field) => `(?<${field.name}>${field.pattern})`).join(String.raw`\n`)}\n$`,
  'u',
);

const RESPONSE_SCHEMA = z.object({
  size: z.string().transform(Number).pipe(z.number().int().nonnegative()),
  blocks: z.string().transform((blocks) => Buffer.from(blocks.replaceAll('\n', ''), 'base64')),
} satisfies Record<ResponseField, z.ZodType>);

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
