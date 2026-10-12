import type { Clock } from './system-clock';

interface WaitUntilOptions {
  readonly clock: Clock;

  // How long the wait pauses between two checks of the condition.
  readonly intervalMs: number;

  // The time, in milliseconds since the epoch on the clock, after which the
  // wait stops checking.
  readonly deadlineMs: number;
}

/**
 * Checks the condition, then again every `intervalMs` on the clock, and
 * resolves `true` as soon as it holds. Once a check that fails finds the
 * clock at or past `deadlineMs`, the wait resolves `false`. The condition
 * always runs at least once, and once more after the pause that crosses the
 * deadline, so a condition that comes true during that pause still counts.
 * A condition that throws rejects the wait.
 */
export async function waitUntil(
  condition: () => boolean | Promise<boolean>,
  options: WaitUntilOptions,
): Promise<boolean> {
  for (;;) {
    const holds = await condition();

    if (holds) {
      return true;
    }

    if (options.clock.now() >= options.deadlineMs) {
      return false;
    }

    const paused = Promise.withResolvers<void>();

    options.clock.schedule(paused.resolve, options.intervalMs);

    await paused.promise;
  }
}
