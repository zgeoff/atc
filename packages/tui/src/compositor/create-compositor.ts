import type { Clock } from '@atc/core';
import { buildCellBuffer } from './build-cell-buffer';
import { renderFlush } from './render-flush';
import type { CellBuffer, CursorPlacement, FrameInfo, Layer, TerminalFacts } from './types';

export interface CompositorDeps {
  readonly clock: Clock;
  readonly write: (chunk: string) => void;
  readonly readSize: () => { readonly cols: number; readonly rows: number };
  readonly readFacts: () => TerminalFacts;

  // where the user's terminal cursor goes: the focused layer's cursor, or null for none
  readonly readCursor: () => CursorPlacement | null;
}

interface Frame {
  readonly buffer: CellBuffer;
  readonly info: FrameInfo;
}

export interface Compositor {
  readonly compose: (layers: readonly Layer[]) => Frame;
  readonly flush: (frame: Frame) => void;

  // the next flush repaints the whole terminal, after something else wrote to it
  readonly invalidate: () => void;
}

export function createCompositor(deps: CompositorDeps): Compositor {
  let shown: CellBuffer | null = null;
  let shownCursor: CursorPlacement | null = null;

  return {
    compose: (layers) => {
      const size = deps.readSize();

      const info: FrameInfo = {
        now: deps.clock.now(),
        cols: size.cols,
        rows: size.rows,
        terminal: deps.readFacts(),
      };

      const buffer = buildCellBuffer(size.cols, size.rows);

      for (const layer of layers) {
        layer.draw(buffer, info);
      }

      return { buffer, info };
    },

    flush: (frame) => {
      const plan = renderFlush({
        shown,
        next: frame.buffer,
        depth: frame.info.terminal.depth,
        cursor: deps.readCursor(),
        shownCursor,
      });

      shown = frame.buffer;
      shownCursor = plan.shownCursor;

      if (plan.output !== '') {
        deps.write(plan.output);
      }
    },

    invalidate: () => {
      shown = null;
      shownCursor = null;
    },
  };
}
