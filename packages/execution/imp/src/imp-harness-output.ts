import { ansi } from '@atc/core';
import type { ImpSessionStarted } from './imp-port';

// The bytes a fresh attach sends listeners ahead of its replay: reset the
// attributes, home the cursor, and clear the screen. A full terminal reset
// would also undo the modes of every attached client's own terminal.
const SCREEN_RESET = `${ansi.reset}${ansi.cursorHome}${ansi.eraseScreen}`;

type SessionOffsets = Extract<ImpSessionStarted['output'], { continuity: 'offsets' }>;

// The output a harness's connections carry, decoded for its listeners, and
// where in the session's output the daemon stands.
export class ImpHarnessOutput {
  private readonly emitData: (text: string) => void;

  private decoder = new TextDecoder();

  // The boot and generation the daemon's output came from, while impd
  // carries offsets for the session.
  private cursor: { readonly bootId: string; readonly generation: string } | null = null;

  // The offset after the last byte the daemon has, the offset the current
  // connection's next byte sits at, and the mode bytes still owed before
  // it, which have no offset.
  private highWater = 0;

  private nextOffset = 0;

  private preludeLeft = 0;

  constructor(emitData: (text: string) => void) {
    this.emitData = emitData;
  }

  // A start that resumes nothing meets the screen afresh when asked to, and
  // the daemon's position restarts at the connection's first offset.
  applyStart(offsets: SessionOffsets | null, needsFreshScreen: boolean): void {
    if (offsets === null || offsets.resume === undefined) {
      if (needsFreshScreen) {
        this.decoder = new TextDecoder();

        this.emitData(SCREEN_RESET);
      }

      this.highWater = offsets?.offset ?? 0;
    }

    this.cursor =
      offsets === null ? null : { bootId: offsets.bootId, generation: offsets.executionGeneration };

    this.nextOffset = offsets?.offset ?? 0;
    this.preludeLeft = offsets?.prelude ?? 0;
  }

  // The mode bytes ahead of a fresh replay go to the screen uncounted; every
  // byte after them sits at an offset, and one below the high-water mark is
  // a repeat the daemon already has.
  applyOutput(data: Uint8Array): void {
    let bytes = data;

    if (this.preludeLeft > 0) {
      const prelude = bytes.subarray(0, this.preludeLeft);

      this.preludeLeft -= prelude.length;

      this.emitData(this.decoder.decode(prelude, { stream: true }));

      bytes = bytes.subarray(prelude.length);
    }

    if (this.cursor !== null) {
      const start = this.nextOffset;

      this.nextOffset += bytes.length;
      bytes = bytes.subarray(Math.max(0, this.highWater - start));
      this.highWater = Math.max(this.highWater, this.nextOffset);
    }

    if (bytes.length > 0) {
      this.emitData(this.decoder.decode(bytes, { stream: true }));
    }
  }

  getCursor(): Readonly<{ bootId: string; generation: string }> | null {
    return this.cursor;
  }

  getHighWater(): number {
    return this.highWater;
  }

  // A resume impd refuses leaves no position to resume from.
  resetCursor(): void {
    this.cursor = null;
  }
}
