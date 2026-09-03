import { SerializeAddon } from '@xterm/addon-serialize';
import { Terminal } from '@xterm/headless';
import { RESET_INPUT_MODES } from '../shared/reset-input-modes';

export interface ScreenText {
  readonly text: string;
  readonly cols: number;
  readonly rows: number;
}

// The serializer already re-emits the modes the vt engine models (mouse
// tracking, bracketed paste, focus events); these are the ones it drops.
const REPLAYED_DEC_MODES = new Set([1006, 1007, 2031]);

/**
 * A per-session vt state machine: consumes every PTY byte continuously and
 * renders the current screen as an ANSI replay string, so attaching a
 * client is an instant repaint instead of a resize jiggle. Scrollback is
 * capped aggressively — the model exists for the current screen, not
 * history; transcripts on disk are the durable copy.
 *
 * The serializer covers buffer content and the modes the vt engine tracks,
 * but not the input-encoding state a fullscreen agent sets: SGR mouse
 * encoding, alternate scroll, color-scheme reports, the kitty keyboard
 * protocol, and modifyOtherKeys. Those are tracked here and folded into the
 * replay, which first resets every input mode so a replay painted over
 * another session's screen never inherits its input state.
 */
export class ScreenModel {
  private readonly term: Terminal;

  private readonly serializer: SerializeAddon;

  private flushed: Promise<void> = Promise.resolve();

  private readonly decModes = new Map<number, boolean>();

  private readonly kittyFlags: number[] = [];

  private modifyOtherKeys = 0;

  constructor(cols: number, rows: number) {
    this.term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 300 });
    this.serializer = new SerializeAddon();

    this.term.loadAddon(this.serializer);

    for (const final of ['h', 'l'] as const) {
      this.term.parser.registerCsiHandler({ prefix: '?', final }, (params) => {
        for (const p of params) {
          if (typeof p === 'number' && REPLAYED_DEC_MODES.has(p)) {
            this.decModes.set(p, final === 'h');
          }
        }

        return false;
      });
    }

    this.term.parser.registerCsiHandler({ prefix: '>', final: 'u' }, (params) => {
      const flags = typeof params[0] === 'number' ? params[0] : 0;

      this.kittyFlags.push(flags);

      return false;
    });

    this.term.parser.registerCsiHandler({ prefix: '<', final: 'u' }, (params) => {
      const count = typeof params[0] === 'number' && params[0] > 0 ? params[0] : 1;

      this.kittyFlags.splice(Math.max(0, this.kittyFlags.length - count));

      return false;
    });

    this.term.parser.registerCsiHandler({ prefix: '>', final: 'm' }, (params) => {
      if (params[0] === 4) {
        this.modifyOtherKeys = typeof params[1] === 'number' ? params[1] : 0;
      }

      return false;
    });
  }

  record(data: string): void {
    this.flushed = new Promise((resolve) => {
      this.term.write(data, () => {
        resolve();
      });
    });
  }

  // The terminal parses asynchronously, and bytes recorded while a flush is
  // awaited re-arm it — so the replay drains until no newer write is
  // pending. Serializing earlier would omit bytes already streamed live to
  // clients, and the replay's leading clear would erase them from the
  // client's screen for good.
  async renderReplay(): Promise<string> {
    let pending: Promise<void>;

    do {
      pending = this.flushed;

      await pending;
    } while (pending !== this.flushed);

    return RESET_INPUT_MODES + this.renderVisibleScreen() + this.renderInputModes();
  }

  // The visible rows of whichever buffer the session is showing, as plain
  // text with no escape sequences: one line per row, trailing blanks
  // trimmed from each row, trailing blank rows dropped. Drains pending
  // writes the same way the replay does, so text recorded just before the
  // read is never missing from it.
  async renderText(): Promise<ScreenText> {
    let pending: Promise<void>;

    do {
      pending = this.flushed;

      await pending;
    } while (pending !== this.flushed);

    const buffer = this.term.buffer.active;
    const lines: string[] = [];

    for (let y = 0; y < this.term.rows; y++) {
      lines.push((buffer.getLine(buffer.baseY + y)?.translateToString(true) ?? '').trimEnd());
    }

    while (lines.length > 0 && lines.at(-1) === '') {
      lines.pop();
    }

    return { text: lines.join('\n'), cols: this.term.cols, rows: this.term.rows };
  }

  updateDims(cols: number, rows: number): void {
    this.term.resize(cols, rows);
  }

  stop(): void {
    this.term.dispose();
  }

  // A session on the alternate screen serializes as the normal buffer, a
  // buffer switch, then the alternate buffer. The switch clears nothing on a
  // terminal already in alternate mode — and the client always is, since its
  // chrome runs there — so the normal-buffer paint would linger under the
  // alternate one, showing through every cell the serializer skips as blank.
  // The replay therefore keeps only what the switch precedes: the content of
  // the buffer the session is actually showing.
  private renderVisibleScreen(): string {
    const serialized = this.serializer.serialize();
    const altSwitch = '\u001B[?1049h\u001B[H';
    const switchAt = serialized.lastIndexOf(altSwitch);

    return switchAt === -1 ? serialized : serialized.slice(switchAt + altSwitch.length);
  }

  private renderInputModes(): string {
    let out = '';

    for (const [mode, on] of this.decModes) {
      if (on) {
        out += `\u001B[?${mode}h`;
      }
    }

    for (const flags of this.kittyFlags) {
      out += `\u001B[>${flags}u`;
    }

    if (this.modifyOtherKeys > 0) {
      out += `\u001B[>4;${this.modifyOtherKeys}m`;
    }

    return out;
  }
}
