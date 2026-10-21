import type { ScreenMenu } from '@atc/plugin-api';
import type { Dims } from './create-attach-registry';
import type { ScreenModel } from './create-screen-model';
import { createSessionInputQueue } from './create-session-input-queue';
import type { SessionInputQueue } from './create-session-input-queue';

// The daemon's own bookkeeping for one live headless run: enough to stop it
// on eject, kill, or session removal.
interface HeadlessRunHandle {
  readonly stop: () => void;
}

export interface SessionRuntime {
  screen: ScreenModel | null;

  seq: number;

  // When the session's PTY last printed anything, by the daemon's clock; a
  // menu choice waits for the screen to go quiet before its first key.
  lastOutputAt: number;

  // The whole menu atc last read through a list that scrolls past the
  // screen, so a later read of part of that list numbers its options the
  // same way, or null before any.
  wholeMenu: ScreenMenu | null;

  dims: Dims | null;

  readonly input: SessionInputQueue;

  // Cancel the pending debounced resize and screen detection, each
  // undefined while none waits.
  cancelResize: (() => void) | undefined;

  cancelDetect: (() => void) | undefined;

  headlessRun: HeadlessRunHandle | null;

  pendingEject: (() => void) | null;

  bootWaiter: (() => void) | null;

  // Whether a SessionStart hook is still owed for this session before its
  // agent can be recorded as the last one used; a spawn sets it, the hook
  // clears it, and a spawn that never reports leaves it stranded harmlessly.
  pendingLastUsed: boolean;

  // When the agent reported SessionStart since its terminal last booted, or
  // null before it has. A message queues for a grace window after that, and
  // beyond it only if a tap has attached since the boot.
  startedAt: number | null;

  // Whether a tap has attached since the terminal last booted. A tap that
  // later dropped may be restarting, so it keeps the inbox open.
  tapAttached: boolean;

  // Whether a hook line carrying the session's agent arrived since the
  // terminal last booted. Once one has, the session's own hooks are known
  // to carry it, and a line without one comes from another harness.
  hasAgentHookLines: boolean;

  // The state the session's adapter returned for its last hook line, which
  // goes back to the adapter with the session's next line. A fresh terminal
  // starts with none.
  harnessState: unknown;

  // every path that boots a new terminal for an existing session runs this,
  // so a revived session never inherits its previous process's message gate
  readonly resetBoot: (dims: Dims) => void;

  readonly dispose: () => void;

  // Ends the live headless run, if there is one, and forgets its handle so
  // the session is free to start another.
  readonly stopHeadlessRun: () => void;
}

export function createSessionRuntime(): SessionRuntime {
  const runtime: SessionRuntime = {
    screen: null,

    seq: 0,

    lastOutputAt: 0,

    wholeMenu: null,

    dims: null,

    input: createSessionInputQueue(),

    cancelResize: undefined,

    cancelDetect: undefined,

    headlessRun: null,

    pendingEject: null,

    bootWaiter: null,

    pendingLastUsed: false,

    startedAt: null,

    tapAttached: false,

    hasAgentHookLines: false,

    harnessState: undefined,

    resetBoot: (dims) => {
      runtime.dims = dims;
      runtime.startedAt = null;
      runtime.tapAttached = false;
      runtime.hasAgentHookLines = false;
      runtime.harnessState = undefined;
      runtime.wholeMenu = null;
    },

    dispose: () => {
      runtime.cancelResize?.();
      runtime.cancelDetect?.();
      runtime.cancelResize = undefined;
      runtime.cancelDetect = undefined;
      runtime.screen?.stop();
      runtime.screen = null;

      runtime.stopHeadlessRun();
      runtime.pendingEject?.();
      runtime.pendingEject = null;
      runtime.bootWaiter?.();
      runtime.bootWaiter = null;
    },

    stopHeadlessRun: () => {
      runtime.headlessRun?.stop();
      runtime.headlessRun = null;
    },
  };

  return runtime;
}
