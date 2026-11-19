import type { Clock } from './system-clock';

interface WaitUntilOptions {
  readonly clock: Clock;

  // How long the wait pauses between two checks of the condition.
  readonly intervalMs: number;

  // The time, in milliseconds since the epoch on the clock, after which the
  // wait stops checking.
  readonly deadlineMs: number;
}

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
