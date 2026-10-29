import type { TranscriptRow } from '@atcx/contract';

export interface TranscriptPosition {
  readonly path: string;
  readonly offset: number;
}

export interface TranscriptPage {
  readonly rows: TranscriptRow[];
  readonly offset: number;
  readonly more: boolean;
}

// Bytes of a transcript from an offset, and the size the file had when they
// were read.
export interface TranscriptWindow {
  readonly size: number;
  readonly bytes: Uint8Array;
}

// Reads at most length bytes of the file at path from offset, or null when
// there is no file.
export type ReadTranscriptWindow = (
  path: string,
  offset: number,
  length: number,
) => Promise<TranscriptWindow | null>;

interface TranscriptPageRequest {
  readonly path: string;
  readonly from: TranscriptPosition | null;
  readonly limit: number;
  readonly maxBytes: number;
  readonly parseLine: (line: string) => TranscriptRow | null;
  readonly readWindow: ReadTranscriptWindow;
}

// One read window; a line longer than this is skipped unparsed.
const WINDOW_BYTES = 1_048_576;

export async function loadTranscriptPage(req: TranscriptPageRequest): Promise<TranscriptPage> {
  const resumeAt = req.from !== null && req.from.path === req.path ? req.from.offset : 0;

  const start = await readFirstWindow(req, resumeAt);

  if (start === null) {
    return { rows: [], offset: resumeAt, more: false };
  }

  const size = start.window.size;
  let offset = start.offset;
  let first = true;
  const rows: TranscriptRow[] = [];

  const decoder = new TextDecoder();

  let bytes = 0;
  let skipping = false;

  while (offset < size) {
    const length = Math.min(WINDOW_BYTES, size - offset);
    const window = first ? start.window : await req.readWindow(req.path, offset, length);

    first = false;

    // A remote host reads the size before the bytes, so a file that grew
    // between the two returns bytes past that size.
    const chunk = (window?.bytes ?? new Uint8Array()).subarray(0, length);
    let lineStart = 0;
    let newline = chunk.indexOf(0x0a, lineStart);

    if (newline === -1) {
      // A trailing partial line is left for the next read. A short read means the
      // file shrank underneath us, so it ends the scan rather than skipping a line.
      if (chunk.length < length || offset + chunk.length >= size) {
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

// A cursor past the end of a replaced file starts over from the start.
async function readFirstWindow(
  req: TranscriptPageRequest,
  resumeAt: number,
): Promise<{ readonly offset: number; readonly window: TranscriptWindow } | null> {
  const window = await req.readWindow(req.path, resumeAt, WINDOW_BYTES);

  if (window === null) {
    return null;
  }

  if (resumeAt <= window.size) {
    return { offset: resumeAt, window };
  }

  const restarted = await req.readWindow(req.path, 0, WINDOW_BYTES);

  return restarted === null ? null : { offset: 0, window: restarted };
}
