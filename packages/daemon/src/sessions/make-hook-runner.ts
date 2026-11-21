import type { HookEntry, HooksConfig } from '@atc/config';
import type { EventMsg } from '@atc/protocol/wire';
import type { Clock } from '@zgeoff/std';
import { systemClock } from '@zgeoff/std';
import type { Subprocess } from 'bun';

export interface HookScope {
  readonly cwd: string;
  readonly repoRoot: string;
}

type RunHooks = (event: EventMsg, scope: HookScope | null) => void;

export interface HookOutcome {
  readonly command: string;
  readonly exitCode: number | null;
  readonly signalCode: Subprocess['signalCode'];
}

interface HookRunnerOptions {
  readonly onSettled?: (event: EventMsg, outcomes: readonly HookOutcome[]) => void;

  readonly clock?: Pick<Clock, 'now' | 'schedule'>;
}

export function makeHookRunner(hooks: HooksConfig, options: HookRunnerOptions = {}): RunHooks {
  const onSettled = options.onSettled ?? (() => {});
  const clock = options.clock ?? systemClock;

  return (event, scope) => {
    const matched = (hooks[event.ev] ?? []).filter(
      (entry) => entry.directory === undefined || isInScope(entry.directory, scope),
    );

    if (matched.length === 0) {
      onSettled(event, []);

      return;
    }

    void runHooks(matched, event, clock, onSettled);
  };
}

function isInScope(directory: string, scope: HookScope | null): boolean {
  if (scope === null) {
    return false;
  }

  return isUnderDir(scope.repoRoot, directory) || isUnderDir(scope.cwd, directory);
}

function isUnderDir(candidate: string, directory: string): boolean {
  const prefix = directory === '/' ? '/' : `${directory}/`;

  return candidate === directory || candidate.startsWith(prefix);
}

async function runHooks(
  entries: readonly HookEntry[],
  event: EventMsg,
  clock: Pick<Clock, 'now' | 'schedule'>,
  onSettled: (event: EventMsg, outcomes: readonly HookOutcome[]) => void,
): Promise<void> {
  const outcomes = await Promise.all(entries.map((entry) => runHook(entry, event, clock)));

  onSettled(event, outcomes);
}

const DEFAULT_TIMEOUT_MS = 10_000;

async function runHook(
  entry: HookEntry,
  event: EventMsg,
  clock: Pick<Clock, 'now' | 'schedule'>,
): Promise<HookOutcome> {
  let subprocess: ReturnType<typeof Bun.spawn>;

  try {
    subprocess = Bun.spawn(['/bin/sh', '-c', entry.command], {
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
    subprocess.kill();
  }, entry.timeout ?? DEFAULT_TIMEOUT_MS);

  try {
    const code = await subprocess.exited;

    if (code !== 0) {
      console.error(`atc hook for ${event.ev} exited ${code}`);
    }

    return {
      command: entry.command,
      exitCode: subprocess.exitCode,
      signalCode: subprocess.signalCode,
    };
  } finally {
    disarm();
  }
}
