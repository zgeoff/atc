import type { ScreenMenu } from '@atc/plugin-api';
import type { Dims } from './attach-registry';
import type { ScreenModel } from './screen-model';
import { SessionInputQueue } from './session-input-queue';

// The daemon's own bookkeeping for one live headless run: enough to stop it
// on eject, kill, or session removal.
interface HeadlessRunHandle {
  readonly stop: () => void;
}

/**
 * Everything the daemon tracks for one session: its screen model, output
 * sequence counter, PTY dims, the queue its input writes run through, its
 * resize/detect/boot timers, its live headless run, its adapter's hook
 * state, and its pending eject and boot waiters. `dispose` releases all of it in one call, and is safe to
 * call more than once.
 */
export class SessionRuntime {
  screen: ScreenModel | null = null;

  seq = 0;

  // When the session's PTY last printed anything, by the daemon's clock; a
  // menu choice waits for the screen to go quiet before its first key.
  lastOutputAt = 0;

  // The whole menu atc last read through a list that scrolls past the
  // screen, so a later read of part of that list numbers its options the
  // same way, or null before any.
  wholeMenu: ScreenMenu | null = null;

  dims: Dims | null = null;

  readonly input = new SessionInputQueue();

  // Cancel the pending debounced resize and screen detection, each
  // undefined while none waits.
  cancelResize: (() => void) | undefined;

  cancelDetect: (() => void) | undefined;

  headlessRun: HeadlessRunHandle | null = null;

  pendingEject: (() => void) | null = null;

  bootWaiter: (() => void) | null = null;

  // Whether a SessionStart hook is still owed for this session before its
  // agent can be recorded as the last one used; a spawn sets it, the hook
  // clears it, and a spawn that never reports leaves it stranded harmlessly.
  pendingLastUsed = false;

  // When the agent reported SessionStart since its terminal last booted, or
  // null before it has. A message queues for a grace window after that, and
  // beyond it only if a tap has attached since the boot.
  startedAt: number | null = null;

  // Whether a tap has attached since the terminal last booted. A tap that
  // later dropped may be restarting, so it keeps the inbox open.
  tapAttached = false;

  // Whether a hook line carrying the session's agent arrived since the
  // terminal last booted. Once one has, the session's own hooks are known
  // to carry it, and a line without one comes from another harness.
  hasAgentHookLines = false;

  // The state the session's adapter returned for its last hook line, which
  // goes back to the adapter with the session's next line. A fresh terminal
  // starts with none.
  harnessState: unknown = undefined;

  // Returns the boot-scoped state to how a fresh terminal starts, at the
  // dims it boots with: no SessionStart yet, no tap since, and no whole
  // menu read through a scrolled list. Every path
  // that boots a new terminal for an existing session runs it, so a revived
  // session never inherits its previous process's message gate.
  resetBoot(dims: Dims): void {
    this.dims = dims;
    this.startedAt = null;
    this.tapAttached = false;
    this.hasAgentHookLines = false;
    this.harnessState = undefined;
    this.wholeMenu = null;
  }

  dispose(): void {
    this.cancelResize?.();
    this.cancelDetect?.();
    this.cancelResize = undefined;
    this.cancelDetect = undefined;
    this.screen?.stop();
    this.screen = null;

    this.stopHeadlessRun();
    this.pendingEject?.();
    this.pendingEject = null;
    this.bootWaiter?.();
    this.bootWaiter = null;
  }

  // Ends the live headless run, if there is one, and forgets its handle so
  // the session is free to start another.
  stopHeadlessRun(): void {
    this.headlessRun?.stop();
    this.headlessRun = null;
  }
}
