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
 * Builds the daemon's hook runner. Each call fires every configured command
 * for the event's name, with the wire-event JSON on stdin and the event name
 * in `ATC_EVENT`. Hooks are observational and fire-and-forget: the daemon
 * never waits on one, a run past its timeout is killed, and a nonzero exit
 * or spawn failure is logged to stderr and otherwise ignored.
 */
export function makeHookRunner(hooks: HooksConfig): RunHooks {
  return (event, scope) => {
    for (const entry of hooks[event.ev] ?? []) {
      if (entry.dir === undefined || isInScope(entry.dir, scope)) {
        runHook(entry, event);
      }
    }
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

const DEFAULT_TIMEOUT_MS = 10_000;

function runHook(entry: HookEntry, event: EventMsg): void {
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

    return;
  }

  // Unref'd so an in-flight hook never keeps the daemon process alive; a
  // hook orphaned by daemon exit is on its own.
  const timer = setTimeout(() => {
    proc.kill();
  }, entry.timeout ?? DEFAULT_TIMEOUT_MS);

  timer.unref();

  void (async () => {
    try {
      const code = await proc.exited;

      if (code !== 0) {
        console.error(`atc hook for ${event.ev} exited ${code}`);
      }
    } finally {
      clearTimeout(timer);
    }
  })();
}
