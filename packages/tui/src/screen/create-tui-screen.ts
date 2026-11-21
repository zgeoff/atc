import { ansi } from '@atc/core';
import type { Clock } from '@atc/core';
import { createCompositor } from '../compositor/create-compositor';
import { createFrameClock } from '../compositor/create-frame-clock';
import type { CursorPlacement, Layer } from '../compositor/types';
import { createSessionEmulator } from '../emulator/create-session-emulator';
import type { SessionEmulator } from '../emulator/create-session-emulator';
import { createFleetBarLayer } from '../fleet-bar/create-fleet-bar-layer';
import type { FleetBarLayerDeps } from '../fleet-bar/create-fleet-bar-layer';
import type { SessionKey } from '../fleet/session-key';
import { filterMouseReports } from '../input-modes/filter-mouse-reports';
import { createTerminalAnswerFilter } from '../terminal-facts/create-terminal-answer-filter';
import { createTerminalFacts } from '../terminal-facts/create-terminal-facts';
import { createEmulatorLayer } from './create-emulator-layer';
import { createModeMirror } from './create-mode-mirror';
import { createSessionStream } from './create-session-stream';
import type { SessionStream } from './create-session-stream';

export interface TUIScreenDeps {
  readonly clock: Clock;

  // the user's terminal; only the compositor and the passthrough write to it
  readonly write: (chunk: string) => void;
  readonly readSize: () => { readonly cols: number; readonly rows: number };
  readonly env: { readonly colorterm: string | undefined; readonly term: string | undefined };
  readonly animations: boolean;
  readonly isSessionFocused: () => boolean;
  readonly fleetBar: FleetBarLayerDeps;
  readonly sendSessionReply: (key: SessionKey, bytes: string) => void;
}

export interface TUIScreen {
  readonly stream: SessionStream;

  // text for the screens that draw with escape sequences: home, the list, help, the picker
  readonly writeScreen: (text: string) => void;
  readonly requestFrame: () => void;
  readonly handleResize: () => void;
  readonly syncModes: () => void;

  // true once the user's terminal answered the kitty keyboard query
  readonly hasKittyKeyboard: () => boolean;

  // Takes a chunk of the user's terminal input, and gives back the keys in it: the answers to the
  // start-up questions are taken out, and so is each mouse report outside the session's area.
  readonly filterInput: (chunk: Buffer) => Buffer | null;
  readonly start: () => void;

  // takes every mirrored mode off the terminal, and ends the frame clock
  readonly stop: () => void;
}

export function createTUIScreen(deps: TUIScreenDeps): TUIScreen {
  const size = deps.readSize();
  const answerFilter = createTerminalAnswerFilter();
  let pendingScreenWrites = 0;

  // the user's terminal can split a paste across input chunks
  let isInPaste = false;

  const facts = createTerminalFacts({
    env: deps.env,
    clock: deps.clock,
    write: deps.write,
    onChange: () => {
      frameClock.request();
    },
  });

  const screenEmulator: SessionEmulator = createSessionEmulator({
    cols: size.cols,
    rows: size.rows,
    readFacts: facts.read,
  });

  const stream = createSessionStream({
    createEmulator: (cols, rows) => createSessionEmulator({ cols, rows, readFacts: facts.read }),
    onReply: deps.sendSessionReply,
    onPassthrough: deps.write,
    onChange: () => {
      frameClock.request();
    },
  });

  const sessionLayer = createEmulatorLayer({
    readEmulator: stream.readEmulator,
    isRowDrawn: () => true,
  });

  const screenLayer = createEmulatorLayer({
    readEmulator: () => screenEmulator,
    isRowDrawn: () => true,
  });

  // the last row stays free of the session, so a notice that a screen writes there shows over it
  const noticeLayer = createEmulatorLayer({
    readEmulator: () => screenEmulator,
    isRowDrawn: (row, frame) => row === frame.rows - 1,
  });

  const barLayer = createFleetBarLayer(deps.fleetBar);

  // the bar draws after the notice layer, which blanks the last row, and only when no notice shows;
  // it also draws over a screen, such as the session list, that leaves the last row blank
  const collectLayers = (): readonly Layer[] =>
    deps.isSessionFocused() ? [sessionLayer, noticeLayer, barLayer] : [screenLayer, barLayer];

  const readCursor = (): CursorPlacement | null => {
    const emulator = deps.isSessionFocused() ? stream.readEmulator() : screenEmulator;

    return emulator === null ? null : emulator.readCursor();
  };

  const compositor = createCompositor({
    clock: deps.clock,
    write: deps.write,
    readSize: deps.readSize,
    readFacts: facts.read,
    readCursor,
  });

  const mirror = createModeMirror({
    write: deps.write,
    hasKittyKeyboard: () => facts.read().kittyKeyboard,
    readSessionModes: () => stream.readEmulator()?.readInputModes() ?? null,
    isSessionFocused: deps.isSessionFocused,
  });

  const frameClock = createFrameClock({
    clock: deps.clock,
    animations: deps.animations,
    collectLayers,
    drawFrame: () => {
      mirror.sync();

      if (pendingScreenWrites === 0 && stream.isSettled()) {
        compositor.flush(compositor.compose(collectLayers()));
      }
    },
  });

  const writeToScreen = async (text: string): Promise<void> => {
    pendingScreenWrites += 1;

    await screenEmulator.write(text);

    pendingScreenWrites -= 1;

    frameClock.request();
  };

  return {
    stream,

    // A screen that clears the terminal starts over, so the next frame repaints every cell.
    writeScreen: (text) => {
      if (text.includes(ansi.eraseScreen)) {
        compositor.invalidate();
      }

      void writeToScreen(text);
    },

    requestFrame: frameClock.request,

    handleResize: () => {
      const next = deps.readSize();

      screenEmulator.resize(next.cols, next.rows);
      frameClock.request();
    },

    syncModes: mirror.sync,

    hasKittyKeyboard: () => facts.read().kittyKeyboard,

    filterInput: (chunk) => {
      const result = answerFilter.push(chunk.toString('latin1'));

      for (const answer of result.answers) {
        facts.apply(answer);
      }

      const emulator = stream.readEmulator();

      const filtered = filterMouseReports(
        result.keys,
        emulator?.readSize() ?? deps.readSize(),
        isInPaste,
      );

      isInPaste = filtered.isInPaste;

      const mouse = emulator?.readInputModes().mouse ?? 'off';
      const keys = deps.isSessionFocused() && mouse !== 'off' ? filtered.data : result.keys;

      return keys === '' ? null : Buffer.from(keys, 'latin1');
    },

    start: () => {
      facts.start();
      frameClock.request();
    },

    stop: () => {
      frameClock.stop();
      mirror.reset();
    },
  };
}
