import type { TranscriptRow } from '../agents/agent-adapter';

export interface TranscriptPosition {
  readonly path: string;
  readonly offset: number;
}

export interface TranscriptPage {
  readonly rows: TranscriptRow[];
  readonly offset: number;
  readonly more: boolean;
}

interface TranscriptPageRequest {
  readonly path: string;
  readonly from: TranscriptPosition | null;
  readonly limit: number;
  readonly maxBytes: number;
  readonly parseLine: (line: string) => TranscriptRow | null;
}

export async function readTranscriptPage(req: TranscriptPageRequest): Promise<TranscriptPage> {
  const file = Bun.file(req.path);

  if (!(await file.exists())) {
    return {
      rows: [],
      offset: req.from?.path === req.path ? req.from.offset : 0,
      more: false,
    };
  }

  const size = file.size;

  // One read window; a line longer than this is skipped unparsed.
  const windowBytes = 1_048_576;

  // A cursor from another file, or past the end of a replaced one, starts over.
  let offset =
    req.from !== null && req.from.path === req.path && req.from.offset <= size
      ? req.from.offset
      : 0;

  const rows: TranscriptRow[] = [];

  const decoder = new TextDecoder();

  let bytes = 0;
  let skipping = false;

  while (offset < size) {
    const chunk = await file.slice(offset, Math.min(offset + windowBytes, size)).bytes();

    let lineStart = 0;
    let newline = chunk.indexOf(0x0a, lineStart);

    if (newline === -1) {
      // A trailing partial line is left for the next read. A short read means the
      // file shrank underneath us, so it ends the scan rather than skipping a line.
      if (chunk.length < Math.min(windowBytes, size - offset) || offset + chunk.length >= size) {
        break;
      }

      offset += chunk.length;
      skipping = true;
      continue;
    }

    while (newline !== -1) {
      const row = skipping
        ? null
        : req.parseLine(decoder.decode(chunk.subarray(lineStart, newline)));

      skipping = false;

      if (row !== null) {
        const rowBytes = Buffer.byteLength(JSON.stringify(row));

        if (rows.length > 0 && bytes + rowBytes > req.maxBytes) {
          return { rows, offset: offset + lineStart, more: true };
        }

        rows.push(row);

        bytes += rowBytes;
      }

      lineStart = newline + 1;

      if (rows.length >= req.limit) {
        return { rows, offset: offset + lineStart, more: true };
      }

      newline = chunk.indexOf(0x0a, lineStart);
    }

    offset += lineStart;
  }

  return { rows, offset, more: false };
}
