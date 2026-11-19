import { ansi } from '@atc/core';
import type { ImpSessionStarted } from '../port/imp-port';

type SessionOffsets = Extract<ImpSessionStarted['output'], { continuity: 'offsets' }>;

export interface ImpHarnessOutput {
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

// A full terminal reset would also undo the modes of every attached client's own terminal,
// so clear only attributes, cursor and screen.
const SCREEN_RESET = `${ansi.reset}${ansi.cursorHome}${ansi.eraseScreen}`;

export function createImpHarnessOutput(emitData: (text: string) => void): ImpHarnessOutput {
  let decoder = new TextDecoder();

  let cursor: { readonly bootId: string; readonly generation: string } | null = null;

  // The daemon sends mode bytes before each connection's stream, and those bytes carry no
  // offset, so they pass through before offset counting starts.
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
