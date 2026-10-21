import { ansi } from '@atc/core';
import type { ImpSessionStarted } from './imp-port';

type SessionOffsets = Extract<ImpSessionStarted['output'], { continuity: 'offsets' }>;

// The output a harness's connections carry, decoded for its listeners, and
// where in the session's output the daemon stands.
export interface ImpHarnessOutput {
  // A start that resumes nothing meets the screen afresh when asked to, and
  // the daemon's position restarts at the connection's first offset.
  readonly applyStart: (offsets: SessionOffsets | null, needsFreshScreen: boolean) => void;

  // The mode bytes ahead of a fresh replay go to the screen uncounted; every
  // byte after them sits at an offset, and one below the high-water mark is
  // a repeat the daemon already has.
  readonly applyOutput: (data: Uint8Array) => void;

  readonly findCursor: () => Readonly<{ bootId: string; generation: string }> | null;

  readonly getHighWater: () => number;

  // A resume impd refuses leaves no position to resume from.
  readonly resetCursor: () => void;
}

// The bytes a fresh attach sends listeners ahead of its replay: reset the
// attributes, home the cursor, and clear the screen. A full terminal reset
// would also undo the modes of every attached client's own terminal.
const SCREEN_RESET = `${ansi.reset}${ansi.cursorHome}${ansi.eraseScreen}`;

export function createImpHarnessOutput(emitData: (text: string) => void): ImpHarnessOutput {
  let decoder = new TextDecoder();

  // The boot and generation the daemon's output came from, while impd
  // carries offsets for the session.
  let cursor: { readonly bootId: string; readonly generation: string } | null = null;

  // The offset after the last byte the daemon has, the offset the current
  // connection's next byte sits at, and the mode bytes still owed before
  // it, which have no offset.
  let highWater = 0;
  let nextOffset = 0;
  let preludeLeft = 0;

  return {
    applyStart: (offsets, needsFreshScreen) => {
      if (offsets === null || offsets.resume === undefined) {
        if (needsFreshScreen) {
          decoder = new TextDecoder();

          emitData(SCREEN_RESET);
        }

        highWater = offsets?.offset ?? 0;
      }

      cursor =
        offsets === null
          ? null
          : { bootId: offsets.bootId, generation: offsets.executionGeneration };

      nextOffset = offsets?.offset ?? 0;
      preludeLeft = offsets?.prelude ?? 0;
    },

    applyOutput: (data) => {
      let bytes = data;

      if (preludeLeft > 0) {
        const prelude = bytes.subarray(0, preludeLeft);

        preludeLeft -= prelude.length;

        emitData(decoder.decode(prelude, { stream: true }));

        bytes = bytes.subarray(prelude.length);
      }

      if (cursor !== null) {
        const start = nextOffset;

        nextOffset += bytes.length;
        bytes = bytes.subarray(Math.max(0, highWater - start));
        highWater = Math.max(highWater, nextOffset);
      }

      if (bytes.length > 0) {
        emitData(decoder.decode(bytes, { stream: true }));
      }
    },

    findCursor: () => cursor,

    getHighWater: () => highWater,

    resetCursor: () => {
      cursor = null;
    },
  };
}
