import type { HeadlessRunEvents, HeadlessRunRequest, HeadlessRunner } from '@atc/plugin-api';

interface StubHeadlessRun {
  readonly request: HeadlessRunRequest;

  readonly events: HeadlessRunEvents;
  stopped: boolean;
}

interface StubHeadlessRunner {
  readonly runner: HeadlessRunner;

  readonly runs: readonly StubHeadlessRun[];

  readonly waitForRun: (index: number) => Promise<StubHeadlessRun>;
}

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
