/**
 * Times the named steps of one launch, such as a spawn or a wake on a
 * remote host.
 */
export interface StepTimer {
  // Runs the step and adds its time under its name, a step that throws
  // included; a step that runs more than once counts its runs.
  readonly withStep: <T>(step: string, run: () => Promise<T>) => Promise<T>;

  // Each step in the order it first ran, with its milliseconds and, for a
  // step that ran more than once, its run count, then the time since the
  // timer started.
  readonly formatSteps: () => string;
}

export function createStepTimer(now: () => number = () => performance.now()): StepTimer {
  const started = now();

  const steps = new Map<string, { ms: number; runs: number }>();

  return {
    withStep: async (step, run) => {
      const start = now();

      try {
        return await run();
      } finally {
        const held = steps.get(step) ?? { ms: 0, runs: 0 };

        held.ms += now() - start;
        held.runs += 1;

        steps.set(step, held);
      }
    },
    formatSteps: () => {
      const timed = [...steps].map(([step, held]) =>
        held.runs === 1
          ? `${step} ${Math.round(held.ms)}`
          : `${step} ${Math.round(held.ms)} (x${held.runs})`,
      );

      return [...timed, `total ${Math.round(now() - started)}`].join(', ');
    },
  };
}
