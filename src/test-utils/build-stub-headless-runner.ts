import type {
  HeadlessRunEvents,
  HeadlessRunRequest,
  HeadlessRunner,
} from '../agents/agent-adapter';

interface StubHeadlessRun {
  readonly request: HeadlessRunRequest;

  // The events the daemon listens on, which the test calls to play the run.
  readonly events: HeadlessRunEvents;
  stopped: boolean;
}

interface StubHeadlessRunner {
  readonly runner: HeadlessRunner;

  // Every run the daemon started, in order, and whether it stopped it.
  readonly runs: readonly StubHeadlessRun[];

  // Resolves with the run at the index, counting from zero, once the
  // daemon starts it.
  readonly waitForRun: (index: number) => Promise<StubHeadlessRun>;
}

/**
 * A headless runner for daemon tests that starts no process. Each run the
 * daemon starts is recorded in `runs`, in order, and does nothing until
 * the test plays it by calling the run's events: output, a finished turn,
 * or a turn that needs the user. A stop marks the run stopped and plays
 * nothing, as a killed turn reports nothing more.
 */
export function buildStubHeadlessRunner(): StubHeadlessRunner {
  const runs: StubHeadlessRun[] = [];
  const started: PromiseWithResolvers<StubHeadlessRun>[] = [];

  const getStarted = (index: number) => {
    started[index] ??= Promise.withResolvers<StubHeadlessRun>();

    return started[index];
  };

  return {
    runner: (request, events) => {
      const run: StubHeadlessRun = { request, events, stopped: false };

      runs.push(run);

      getStarted(runs.length - 1).resolve(run);

      return {
        stop: () => {
          run.stopped = true;
        },
      };
    },
    runs,
    waitForRun: (index) => getStarted(index).promise,
  };
}
