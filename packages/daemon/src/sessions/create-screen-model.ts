import { RESET_INPUT_MODES, ansi } from '@atc/core';
import { SerializeAddon } from '@xterm/addon-serialize';
import { Terminal } from '@xterm/headless';

export interface ScreenText {
  readonly text: string;
  readonly cols: number;
  readonly rows: number;
}

// The serializer already re-emits the modes the vt engine models (mouse
// tracking, bracketed paste, focus events); these are the ones it drops.
const REPLAYED_DEC_MODES = new Set([1006, 1007, 2031]);

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

  readonly hasBracketedPaste: () => boolean;

  readonly captureText: () => Promise<ScreenText>;
  readonly updateDims: (cols: number, rows: number) => void;
  readonly stop: () => void;
}

export function createScreenModel(cols: number, rows: number): ScreenModel {
  let flushed: Promise<void> = Promise.resolve();

  const decModes = new Map<number, boolean>();

  const kittyFlags: number[] = [];
  let modifyOtherKeys = 0;

  const term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 300 });
  const serializer = new SerializeAddon();

  term.loadAddon(serializer);

  // the serializer drops the input-encoding state a fullscreen agent sets,
  // so these handlers track it for the replay
  for (const final of ['h', 'l'] as const) {
    term.parser.registerCsiHandler({ prefix: '?', final }, (params) => {
      for (const parameter of params) {
        if (typeof parameter === 'number' && REPLAYED_DEC_MODES.has(parameter)) {
          decModes.set(parameter, final === 'h');
        }
      }

      return false;
    });
  }

  term.parser.registerCsiHandler({ prefix: '>', final: 'u' }, (params) => {
    const flags = typeof params[0] === 'number' ? params[0] : 0;

    kittyFlags.push(flags);

    return false;
  });

  term.parser.registerCsiHandler({ prefix: '<', final: 'u' }, (params) => {
    const count = typeof params[0] === 'number' && params[0] > 0 ? params[0] : 1;

    kittyFlags.splice(Math.max(0, kittyFlags.length - count));

    return false;
  });

  term.parser.registerCsiHandler({ prefix: '>', final: 'm' }, (params) => {
    if (params[0] === 4) {
      modifyOtherKeys = typeof params[1] === 'number' ? params[1] : 0;
    }

    return false;
  });

  const waitForFlush = async (): Promise<void> => {
    let pending: Promise<void>;

    do {
      pending = flushed;

      await pending;
    } while (pending !== flushed);
  };

  // the client is always in alternate mode, where the buffer switch clears
  // nothing, so a normal-buffer paint before it would show through blank
  // cells: keep only what follows the last switch
  const renderVisibleScreen = (): string => {
    const serialized = serializer.serialize();
    const altSwitch = `${ansi.altScreenOn}${ansi.cursorHome}`;
    const switchAt = serialized.lastIndexOf(altSwitch);

    return switchAt === -1 ? serialized : serialized.slice(switchAt + altSwitch.length);
  };

  const renderInputModes = (): string => {
    let out = '';

    for (const [mode, on] of decModes) {
      if (on) {
        out += `\u001B[?${mode}h`;
      }
    }

    for (const flags of kittyFlags) {
      out += `\u001B[>${flags}u`;
    }

    if (modifyOtherKeys > 0) {
      out += `\u001B[>4;${modifyOtherKeys}m`;
    }

    return out;
  };

  return {
    record: (data) => {
      flushed = new Promise((resolve) => {
        term.write(data, () => {
          resolve();
        });
      });
    },

    captureReplay: async () => {
      await waitForFlush();

      return RESET_INPUT_MODES + renderVisibleScreen() + renderInputModes();
    },

    captureFullReplay: async (readMark) => {
      await waitForFlush();

      return {
        replay: RESET_INPUT_MODES + serializer.serialize() + renderInputModes(),
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
