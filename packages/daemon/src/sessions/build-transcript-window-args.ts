import { BLOCK_BYTES } from './constants';

export function buildTranscriptWindowArgs(
  path: string,
  offset: number,
  length: number,
): readonly string[] {
  const first = Math.floor(offset / BLOCK_BYTES);
  const end = Math.ceil((offset + length) / BLOCK_BYTES);

  return [path, String(first), String(end - first)];
}
