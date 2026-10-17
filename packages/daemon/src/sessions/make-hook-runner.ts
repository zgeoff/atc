import type { HookEntry, HooksConfig } from '@atc/config';
import { systemClock } from '@atc/core';
import type { Clock } from '@atc/core';
import type { EventMsg } from '@atc/protocol/wire';

export interface HookScope {
  readonly cwd: string;
  readonly repoRoot: string;
}

type RunHooks = (event: EventMsg, scope: HookScope | null) => void;

export interface HookOutcome {
  readonly command: string;
  readonly exitCode: number | null;
  readonly signalCode: string | null;
}

interface HookRunnerOptions {
  // once per call, after every hook it started has ended; a call that starts none settles at once
  readonly onSettled?: (event: EventMsg, outcomes: readonly HookOutcome[]) => void;

  readonly clock?: Clock;
}

// hooks are fire-and-forget: the daemon never waits on one, and a nonzero exit or spawn failure
// is only logged to stderr
export function makeHookRunner(hooks: HooksConfig, options: HookRunnerOptions = {}): RunHooks {
  const onSettled = options.onSettled ?? (() => {});
  const clock = options.clock ?? systemClock;

  return (event, scope) => {
    const matched = (hooks[event.ev] ?? []).filter(
      (entry) => entry.dir === undefined || isInScope(entry.dir, scope),
    );

    if (matched.length === 0) {
      onSettled(event, []);

      return;
    }

    void runHooks(matched, event, clock, onSettled);
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
  clock: Clock,
  onSettled: (event: EventMsg, outcomes: readonly HookOutcome[]) => void,
): Promise<void> {
  const outcomes = await Promise.all(entries.map((entry) => runHook(entry, event, clock)));

  onSettled(event, outcomes);
}

const DEFAULT_TIMEOUT_MS = 10_000;

async function runHook(entry: HookEntry, event: EventMsg, clock: Clock): Promise<HookOutcome> {
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

  const disarm = clock.schedule(() => {
    proc.kill();
  }, entry.timeout ?? DEFAULT_TIMEOUT_MS);

  try {
    const code = await proc.exited;

    if (code !== 0) {
      console.error(`atc hook for ${event.ev} exited ${code}`);
    }

    return { command: entry.command, exitCode: proc.exitCode, signalCode: proc.signalCode };
  } finally {
    // disarmed on exit, so the armed kill never holds the process open past the hook
    disarm();
  }
}
