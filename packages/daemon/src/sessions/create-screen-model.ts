import { RESET_INPUT_MODES, ansi, createInputModeTracker, formatInputModes } from '@atc/core';
import { SerializeAddon } from '@xterm/addon-serialize';
import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes';
import { Terminal } from '@xterm/headless';
import { readStateReplay } from './read-state-replay';

export interface ScreenText {
  readonly text: string;
  readonly cols: number;
  readonly rows: number;
}

interface FullReplay<T> {
  readonly replay: string;
  readonly cols: number;
  readonly rows: number;
  readonly mark: T;
}

export interface ScreenModel {
  readonly record: (data: string) => void;

  readonly captureReplay: () => Promise<string>;

  readonly captureFullReplay: <T>(readMark: () => T) => Promise<FullReplay<T>>;

  readonly captureStateReplay: <T>(readMark: () => T) => Promise<FullReplay<T>>;

  readonly hasBracketedPaste: () => boolean;

  readonly captureText: () => Promise<ScreenText>;
  readonly updateDims: (cols: number, rows: number) => void;
  readonly stop: () => void;
}

export function createScreenModel(cols: number, rows: number): ScreenModel {
  let flushed: Promise<void> = Promise.resolve();
  const tracker = createInputModeTracker();

  const term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 300 });
  const serializer = new SerializeAddon();

  term.loadAddon(serializer);

  // the client's emulator measures graphemes the same way, so a replay lands in the same cells
  term.loadAddon(new UnicodeGraphemesAddon());

  const waitForFlush = async (): Promise<void> => {
    let pending: Promise<void>;

    do {
      pending = flushed;

      await pending;
    } while (pending !== flushed);
  };

  // The client is always in alternate mode, where a buffer switch clears nothing, so normal-buffer
  // paint from before the last switch would show through the blank cells.
  const renderVisibleScreen = (): string => {
    const serialized = serializer.serialize();
    const altSwitch = `${ansi.altScreenOn}${ansi.cursorHome}`;
    const switchAt = serialized.lastIndexOf(altSwitch);

    return switchAt === -1 ? serialized : serialized.slice(switchAt + altSwitch.length);
  };

  return {
    record: (data) => {
      tracker.write(data);

      flushed = new Promise((resolve) => {
        term.write(data, () => {
          resolve();
        });
      });
    },

    captureReplay: async () => {
      await waitForFlush();

      return RESET_INPUT_MODES + renderVisibleScreen() + formatInputModes(tracker.read());
    },

    captureFullReplay: async (readMark) => {
      await waitForFlush();

      return {
        replay: RESET_INPUT_MODES + serializer.serialize() + formatInputModes(tracker.read()),
        cols: term.cols,
        rows: term.rows,
        mark: readMark(),
      };
    },

    captureStateReplay: async (readMark) => {
      await waitForFlush();

      return {
        replay: readStateReplay({
          term,
          serializer,
          inputModes: tracker.read(),
          kittyStacks: tracker.readKittyStacks(),
        }),
        cols: term.cols,
        rows: term.rows,
        mark: readMark(),
      };
    },

    hasBracketedPaste: () => term.modes.bracketedPasteMode,

    captureText: async () => {
      await waitForFlush();

      const buffer = term.buffer.active;
      const lines: string[] = [];

      for (let y = 0; y < term.rows; y++) {
        lines.push((buffer.getLine(buffer.baseY + y)?.translateToString(true) ?? '').trimEnd());
      }

      while (lines.length > 0 && lines.at(-1) === '') {
        lines.pop();
      }

      return { text: lines.join('\n'), cols: term.cols, rows: term.rows };
    },

    updateDims: (nextCols, nextRows) => {
      term.resize(nextCols, nextRows);
    },

    stop: () => {
      term.dispose();
    },
  };
}
