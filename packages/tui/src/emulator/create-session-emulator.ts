import { createInputModeTracker } from '@atc/core';
import type { InputModes } from '@atc/core';
import { Terminal } from '@xterm/headless';
import { BLANK_CELL } from '../compositor/blank-cell';
import type { Cell, CursorPlacement, TerminalFacts } from '../compositor/types';
import { formatColourReply } from './format-colour-reply';
import { readMember, readXtermCell } from './read-xterm-cell';

export interface SessionEmulatorDeps {
  readonly cols: number;
  readonly rows: number;
  readonly readFacts: () => TerminalFacts;
}

export interface SessionEmulator {
  // takes the bytes in order, and resolves once they are parsed
  readonly write: (data: string) => Promise<void>;

  // forgets the screen, the modes and the scrollback, as a terminal does on a hard reset
  readonly reset: () => Promise<void>;
  readonly resize: (cols: number, rows: number) => void;
  readonly readSize: () => { readonly cols: number; readonly rows: number };
  readonly readCell: (col: number, row: number) => Cell;
  readonly readCursor: () => CursorPlacement;
  readonly readInputModes: () => InputModes;

  // answers to the agent's queries, to send back to the session
  readonly onReply: (listener: (bytes: string) => void) => void;

  // sequences to pass on to the user's terminal
  readonly onPassthrough: (listener: (sequence: string) => void) => void;
  readonly dispose: () => void;
}

// OSC 0 and 2 set the title, OSC 9 and 777 notify, OSC 52 writes the clipboard.
const PASSTHROUGH_OSC = [0, 2, 9, 52, 777] as const;

export function createSessionEmulator(deps: SessionEmulatorDeps): SessionEmulator {
  const term = new Terminal({
    cols: deps.cols,
    rows: deps.rows,
    allowProposedApi: true,
    scrollback: 0,
  });

  const tracker = createInputModeTracker();
  const replyListeners: ((bytes: string) => void)[] = [];
  const passthroughListeners: ((sequence: string) => void)[] = [];

  const reply = (bytes: string): void => {
    for (const listener of replyListeners) {
      listener(bytes);
    }
  };

  const pass = (sequence: string): void => {
    for (const listener of passthroughListeners) {
      listener(sequence);
    }
  };

  term.onData(reply);

  term.onBell(() => {
    pass('\u0007');
  });

  for (const code of PASSTHROUGH_OSC) {
    term.parser.registerOscHandler(code, (data) => {
      // a clipboard read would send the user's clipboard back through the session
      if (!(code === 52 && data.endsWith(';?'))) {
        pass(`\u001B]${code};${data}\u0007`);
      }

      return true;
    });
  }

  for (const code of [10, 11] as const) {
    term.parser.registerOscHandler(code, (data) => {
      if (data === '?') {
        const facts = deps.readFacts();
        const colour = code === 10 ? facts.foreground : facts.background;

        reply(formatColourReply(code, colour));
      }

      return true;
    });
  }

  term.parser.registerCsiHandler({ prefix: '?', final: 'u' }, () => {
    if (deps.readFacts().kittyKeyboard) {
      reply(`\u001B[?${tracker.read().kittyStack.at(-1) ?? 0}u`);
    }

    return true;
  });

  return {
    write: (data) => {
      tracker.write(data);

      return new Promise<void>((resolve) => {
        term.write(data, resolve);
      });
    },

    // a reset in the write queue, so output written before it cannot land after it
    reset: () => {
      tracker.reset();

      return new Promise<void>((resolve) => {
        term.write('\u001Bc', resolve);
      });
    },

    resize: (cols, rows) => {
      term.resize(cols, rows);
    },

    readSize: () => ({ cols: term.cols, rows: term.rows }),

    readCell: (col, row) => {
      const buffer = term.buffer.active;
      const cell = buffer.getLine(buffer.baseY + row)?.getCell(col);

      return cell === undefined ? BLANK_CELL : readXtermCell(term, cell);
    },

    readCursor: () => {
      const buffer = term.buffer.active;
      const coreService = readMember(Reflect.get(term, '_core'), 'coreService');
      const hidden = readMember(coreService, 'isCursorHidden');
      const style = readMember(readMember(coreService, 'decPrivateModes'), 'cursorStyle');

      return {
        col: Math.min(buffer.cursorX, term.cols - 1),
        row: buffer.cursorY,
        visible: hidden !== true,
        shape: style === 'underline' || style === 'bar' ? style : 'block',
      };
    },

    readInputModes: () => tracker.read(),

    onReply: (listener) => {
      replyListeners.push(listener);
    },

    onPassthrough: (listener) => {
      passthroughListeners.push(listener);
    },

    dispose: () => {
      term.dispose();
    },
  };
}
