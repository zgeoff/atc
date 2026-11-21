import type { CellBuffer, FrameInfo, Layer } from '../compositor/types';
import type { SessionEmulator } from '../emulator/create-session-emulator';

export interface EmulatorLayerDeps {
  readonly readEmulator: () => SessionEmulator | null;

  // a row that the layer leaves to the layers below it
  readonly isRowDrawn: (row: number, frame: FrameInfo) => boolean;
}

// Copies the emulator's screen into the buffer at the top left. A cell outside the emulator, or
// in a row the layer leaves out, stays as the layers below drew it.
export function createEmulatorLayer(deps: EmulatorLayerDeps): Layer {
  return {
    draw: (buffer: CellBuffer, frame: FrameInfo) => {
      const emulator = deps.readEmulator();

      if (emulator === null) {
        return;
      }

      const size = emulator.readSize();

      for (let row = 0; row < Math.min(size.rows, frame.rows); row++) {
        if (!deps.isRowDrawn(row, frame)) {
          continue;
        }

        for (let col = 0; col < Math.min(size.cols, frame.cols); col++) {
          buffer.set(col, row, emulator.readCell(col, row));
        }
      }
    },

    nextFrameAt: () => null,
  };
}
