import type { HeadlessRunRequest, HeadlessRunner } from '../agents/agent-adapter';

interface StubHeadlessRun {
  readonly request: HeadlessRunRequest;
  stopped: boolean;
}

interface StubHeadlessRunner {
  readonly runner: HeadlessRunner;

  // Every run the daemon started, in order, and whether it stopped it.
  readonly runs: readonly StubHeadlessRun[];
}

/**
 * A headless runner for daemon tests that runs nothing: each run records
 * the request it was given and stays going, emitting no output, until the
 * daemon stops it, which marks the run as stopped.
 */
export function buildStubHeadlessRunner(): StubHeadlessRunner {
  const runs: StubHeadlessRun[] = [];

  return {
    runner: (request) => {
      const run: StubHeadlessRun = { request, stopped: false };

      runs.push(run);

      return {
        stop: () => {
          run.stopped = true;
        },
      };
    },
    runs,
  };
}
