import type { Dims } from './attach-registry';
import type { ScreenModel } from './screen-model';

// The daemon's own bookkeeping for one live headless run: enough to stop it
// on eject, kill, or session removal.
interface HeadlessRunHandle {
  readonly stop: () => void;
}

/**
 * Everything the daemon tracks for one session: its screen model, output
 * sequence counter, PTY dims, its resize/detect/boot timers, its live
 * headless run, and its pending eject and boot waiters. `dispose` releases
 * all of it in one call, and is safe to call more than once.
 */
export class SessionRuntime {
  screen: ScreenModel | null = null;

  seq = 0;

  dims: Dims | null = null;

  resizeTimer: ReturnType<typeof setTimeout> | undefined;

  detectTimer: ReturnType<typeof setTimeout> | undefined;

  bootTimer: ReturnType<typeof setTimeout> | undefined;

  headlessRun: HeadlessRunHandle | null = null;

  pendingEject: (() => void) | null = null;

  bootWaiter: (() => void) | null = null;

  // Whether a SessionStart hook is still owed for this session before its
  // agent can be recorded as the last one used; a spawn sets it, the hook
  // clears it, and a spawn that never reports leaves it stranded harmlessly.
  pendingLastUsed = false;

  dispose(): void {
    clearTimeout(this.resizeTimer);
    clearTimeout(this.detectTimer);
    clearTimeout(this.bootTimer);

    this.resizeTimer = undefined;
    this.detectTimer = undefined;
    this.bootTimer = undefined;
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
