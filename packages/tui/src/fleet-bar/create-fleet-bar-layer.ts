import { BLANK_CELL } from '../compositor/blank-cell';
import type { CellBuffer, FrameInfo, Layer } from '../compositor/types';
import { SPINNER_FRAMES } from './constants';
import { formatFleetBar } from './format-fleet-bar';
import type { FleetBar } from './types';

// the spinner turns at 10 Hz, whatever the animations setting says
const SPINNER_STEP_MS = 100;

export interface FleetBarLayerDeps {
  // false while home, the list or a notice has the last row
  readonly isShown: () => boolean;

  // true while a session runs, so the spinner needs frames
  readonly isSpinning: () => boolean;
  readonly readBar: (cols: number, spinnerFrame: number) => FleetBar;
}

// Draws the fleet bar on the terminal's last row, over the cells below it, with no background.
export function createFleetBarLayer(deps: FleetBarLayerDeps): Layer {
  return {
    draw: (buffer: CellBuffer, frame: FrameInfo) => {
      if (!deps.isShown() || frame.rows < 1) {
        return;
      }

      const row = frame.rows - 1;
      const spinnerFrame = Math.floor(frame.now / SPINNER_STEP_MS) % SPINNER_FRAMES.length;

      for (const run of formatFleetBar(deps.readBar(frame.cols, spinnerFrame), frame.cols)) {
        let col = run.col;

        for (const ch of run.text) {
          if (col < frame.cols) {
            buffer.set(col, row, { ...BLANK_CELL, ch, fg: run.fg, bold: run.bold });
          }

          col += 1;
        }
      }
    },

    nextFrameAt: (nowMs) =>
      deps.isShown() && deps.isSpinning()
        ? (Math.floor(nowMs / SPINNER_STEP_MS) + 1) * SPINNER_STEP_MS
        : null,
  };
}
