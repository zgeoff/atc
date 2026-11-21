import { RESET_INPUT_MODES, ansi, createInputModeTracker, formatInputModes } from '@atc/core';
import { SerializeAddon } from '@xterm/addon-serialize';
import { Terminal } from '@xterm/headless';
import { readEmulatorInternals } from './read-emulator-internals';
import type { ScrollRegion } from './read-emulator-internals';
import { serializeLinkRuns } from './serialize-link-runs';

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

const RIS = '\u001Bc';

export function createScreenModel(cols: number, rows: number): ScreenModel {
  let flushed: Promise<void> = Promise.resolve();
  const tracker = createInputModeTracker();

  const term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 300 });
  const serializer = new SerializeAddon();

  term.loadAddon(serializer);

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

  // A client that resets its own emulator and writes this gets both buffers, the active one, each
  // cursor, each scroll region and every input mode. The addon puts the alternate buffer last.
  const readStateReplay = (): string => {
    const internals = readEmulatorInternals(term);
    const serialized = serializer.serialize({ excludeModes: true });
    const altSwitch = `${ansi.altScreenOn}${ansi.cursorHome}`;
    const switchAt = serialized.lastIndexOf(altSwitch);
    const normal = switchAt === -1 ? serialized : serialized.slice(0, switchAt);
    const isAlternateActive = switchAt !== -1;
    let out = `${RIS}${normal}${serializeLinkRuns(term, term.buffer.normal)}`;

    out += renderPlacement(
      internals.normalRegion,
      term.buffer.normal,
      term.modes.originMode && !isAlternateActive,
    );

    if (isAlternateActive) {
      out += `${altSwitch}${serialized.slice(switchAt + altSwitch.length)}`;
      out += serializeLinkRuns(term, term.buffer.alternate);
      out += renderPlacement(internals.altRegion, term.buffer.alternate, term.modes.originMode);
    }

    return `${out}${readModes(internals.isCursorHidden)}`;
  };

  const readModes = (isCursorHidden: boolean): string =>
    `${formatInputModes(tracker.read())}${readTerminalModes()}${isCursorHidden ? ansi.hideCursor : ''}`;

  const readTerminalModes = (): string => {
    const modes = term.modes;

    return [
      modes.wraparoundMode ? '' : '\u001B[?7l',
      modes.insertMode ? '\u001B[4h' : '',
      modes.reverseWraparoundMode ? '\u001B[?45h' : '',
    ].join('');
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
        replay: readStateReplay(),
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

interface CursorPosition {
  readonly cursorX: number;
  readonly cursorY: number;
}

function renderPlacement(
  region: ScrollRegion | null,
  buffer: CursorPosition,
  isOriginMode: boolean,
): string {
  // DECSTBM and DECOM each home the cursor, so the cursor goes last. In origin mode its row counts
  // from the top of the scroll region.
  const top = isOriginMode ? (region?.top ?? 0) : 0;
  const row = Math.max(0, buffer.cursorY - top) + 1;
  const regionSequence = region === null ? '' : `\u001B[${region.top + 1};${region.bottom + 1}r`;
  const originSequence = isOriginMode ? '\u001B[?6h' : '';

  return `${regionSequence}${originSequence}\u001B[${row};${buffer.cursorX + 1}H`;
}
