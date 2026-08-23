import { SerializeAddon } from '@xterm/addon-serialize';
import { Terminal } from '@xterm/headless';
import { RESET_INPUT_MODES } from '../shared/reset-input-modes';

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

  // The terminal parses asynchronously; the replay waits for every recorded
  // byte to land in the buffer before serializing.
  async renderReplay(): Promise<string> {
    await this.flushed;

    return RESET_INPUT_MODES + this.serializer.serialize() + this.renderInputModes();
  }

  updateDims(cols: number, rows: number): void {
    this.term.resize(cols, rows);
  }

  stop(): void {
    this.term.dispose();
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
