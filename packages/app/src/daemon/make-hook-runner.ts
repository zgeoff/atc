import type { EventMsg } from '../protocol/protocol';
import type { HookEntry, HooksConfig } from '../shared/collect-hooks';

/**
 * The session paths a hook's `dir` filter is matched against. Null when the
 * event carries no session, in which case only unfiltered hooks fire.
 */
export interface HookScope {
  readonly cwd: string;
  readonly repoRoot: string;
}

export type RunHooks = (event: EventMsg, scope: HookScope | null) => void;

/**
 * How one hook run ended: its exit code, or the signal that ended it, or
 * neither when the command failed to spawn.
 */
export interface HookOutcome {
  readonly command: string;
  readonly exitCode: number | null;
  readonly signalCode: string | null;
}

interface HookRunnerOptions {
  /**
   * Runs once per call, after every hook the call started has exited or
   * failed to spawn, with each one's outcome in configured order; a call
   * that starts none settles at once with none.
   */
  readonly onSettled?: (event: EventMsg, outcomes: readonly HookOutcome[]) => void;

  /**
   * Arms the kill of a run that outlives its timeout and returns the
   * function that disarms it; a timer that never keeps the process alive
   * when unset.
   */
  readonly scheduleKill?: (kill: () => void, timeoutMs: number) => () => void;
}

/**
 * Builds the daemon's hook runner. Each call fires every configured command
 * for the event's name, with the wire-event JSON on stdin and the event name
 * in `ATC_EVENT`. Hooks are observational and fire-and-forget: the daemon
 * never waits on one, a run past its timeout is killed, and a nonzero exit
 * or spawn failure is logged to stderr and otherwise ignored. An event with
 * no matching hook does no work beyond the match.
 */
export function makeHookRunner(hooks: HooksConfig, options: HookRunnerOptions = {}): RunHooks {
  const onSettled = options.onSettled ?? (() => {});
  const scheduleKill = options.scheduleKill ?? scheduleUnrefKill;

  return (event, scope) => {
    const matched = (hooks[event.ev] ?? []).filter(
      (entry) => entry.dir === undefined || isInScope(entry.dir, scope),
    );

    if (matched.length === 0) {
      onSettled(event, []);

      return;
    }

    void runHooks(matched, event, scheduleKill, onSettled);
  };
}

// Unref'd so an in-flight hook never keeps the daemon process alive; a hook
// orphaned by daemon exit is on its own.
function scheduleUnrefKill(kill: () => void, timeoutMs: number): () => void {
  const timer = setTimeout(kill, timeoutMs);

  timer.unref();

  return () => {
    clearTimeout(timer);
  };
}

function isInScope(dir: string, scope: HookScope | null): boolean {
  if (scope === null) {
    return false;
  }

  return isUnderDir(scope.repoRoot, dir) || isUnderDir(scope.cwd, dir);
}

// Path-segment containment: /a/b contains /a/b and /a/b/c, never /a/bc.
function isUnderDir(candidate: string, dir: string): boolean {
  const prefix = dir === '/' ? '/' : `${dir}/`;

  return candidate === dir || candidate.startsWith(prefix);
}

// Starts every hook at once and reports their outcomes once all have ended.
async function runHooks(
  entries: readonly HookEntry[],
  event: EventMsg,
  scheduleKill: (kill: () => void, timeoutMs: number) => () => void,
  onSettled: (event: EventMsg, outcomes: readonly HookOutcome[]) => void,
): Promise<void> {
  const outcomes = await Promise.all(entries.map((entry) => runHook(entry, event, scheduleKill)));

  onSettled(event, outcomes);
}

const DEFAULT_TIMEOUT_MS = 10_000;

async function runHook(
  entry: HookEntry,
  event: EventMsg,
  scheduleKill: (kill: () => void, timeoutMs: number) => () => void,
): Promise<HookOutcome> {
  let proc: ReturnType<typeof Bun.spawn>;

  try {
    proc = Bun.spawn(['/bin/sh', '-c', entry.command], {
      stdin: Buffer.from(`${JSON.stringify(event)}\n`),
      stdout: 'ignore',
      stderr: 'ignore',
      env: { ...process.env, ATC_EVENT: event.ev },
    });
  } catch (error) {
    console.error(`atc hook for ${event.ev} failed to spawn: ${String(error)}`);

    return { command: entry.command, exitCode: null, signalCode: null };
  }

  const disarm = scheduleKill(() => {
    proc.kill();
  }, entry.timeout ?? DEFAULT_TIMEOUT_MS);

  try {
    const code = await proc.exited;

    if (code !== 0) {
      console.error(`atc hook for ${event.ev} exited ${code}`);
    }

    return { command: entry.command, exitCode: proc.exitCode, signalCode: proc.signalCode };
  } finally {
    disarm();
  }
}
