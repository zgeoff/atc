import { ansi } from '@atc/core';
import type { Clock } from '@zgeoff/std';
import { createCompositor } from '../compositor/create-compositor';
import { createFrameClock } from '../compositor/create-frame-clock';
import type { CursorPlacement, Layer } from '../compositor/types';
import { createSessionEmulator } from '../emulator/create-session-emulator';
import type { SessionEmulator } from '../emulator/create-session-emulator';
import { createFleetBarLayer } from '../fleet-bar/create-fleet-bar-layer';
import type { FleetBarLayerDeps } from '../fleet-bar/create-fleet-bar-layer';
import type { SessionKey } from '../fleet/session-key';
import { filterMouseReports } from '../input-modes/filter-mouse-reports';
import { createSessionListLayer } from '../session-list/create-session-list-layer';
import type { SessionListLayerDeps } from '../session-list/create-session-list-layer';
import { createTerminalAnswerFilter } from '../terminal-facts/create-terminal-answer-filter';
import { createTerminalFacts } from '../terminal-facts/create-terminal-facts';
import { createEmulatorLayer } from './create-emulator-layer';
import { createModeMirror } from './create-mode-mirror';
import { createSessionStream } from './create-session-stream';
import type { SessionStream } from './create-session-stream';
import { shouldDrawFrame } from './should-draw-frame';

export interface TUIScreenDeps {
  readonly clock: Pick<Clock, 'now' | 'schedule'>;

  // the user's terminal; only the compositor and the passthrough write to it
  readonly write: (chunk: string) => void;
  readonly readSize: () => { readonly cols: number; readonly rows: number };
  readonly env: { readonly colorterm: string | undefined; readonly term: string | undefined };
  readonly animations: boolean;
  readonly isSessionFocused: () => boolean;

  // true while a session is on screen, whether it has focus or sits behind the session list
  readonly isSessionShown: () => boolean;
  readonly sessionList: Omit<SessionListLayerDeps, 'clock' | 'animations'>;
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

  // when the first frame that found the session output still parsing was asked for
  let waitingSinceMs: number | null = null;

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

  const listLayer = createSessionListLayer({
    ...deps.sessionList,
    clock: deps.clock,
    animations: deps.animations,
  });

  // The panel draws over the session or over the screen below it, and fades out over the screen
  // that replaced it. The bar draws after the notice layer, which blanks the last row, and only
  // when no notice shows. It also draws over the panel, which leaves the last row alone.
  const collectLayers = (): readonly Layer[] => {
    const base = deps.isSessionShown() ? [sessionLayer, noticeLayer] : [screenLayer];

    return listLayer.isVisible() ? [...base, listLayer, barLayer] : [...base, barLayer];
  };

  const readCursor = (): CursorPlacement | null => {
    if (listLayer.isVisible()) {
      return null;
    }

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

      const nowMs = deps.clock.now();

      const isDrawn = shouldDrawFrame({
        isScreenWriting: pendingScreenWrites > 0,
        isStreamSettled: stream.isSettled(),
        isReplaying: stream.isReplaying(),
        waitingSinceMs,
        nowMs,
      });

      if (isDrawn) {
        waitingSinceMs = null;

        compositor.flush(compositor.compose(collectLayers()));
      } else {
        waitingSinceMs ??= nowMs;
      }
    },
  });

  const writeToScreen = async (text: string): Promise<void> => {
    pendingScreenWrites += 1;

    await screenEmulator.write(text);

    pendingScreenWrites -= 1;

    frameClock.request();
  };

  const resizeScreen = async (cols: number, rows: number): Promise<void> => {
    pendingScreenWrites += 1;

    await screenEmulator.resize(cols, rows);

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

      void resizeScreen(next.cols, next.rows);
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
