import type { Clock } from '@zgeoff/std';

interface WaitUntilOptions {
  readonly clock: Pick<Clock, 'now' | 'schedule'>;

  readonly intervalMs: number;

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
