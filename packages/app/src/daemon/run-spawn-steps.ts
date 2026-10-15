import type { SessionID } from '@atc/core';
import { EffectRemainsError } from '@atc/plugin-api';

/**
 * The steps of a spawn, in the order a spawn runs them. A spawn skips the
 * steps it does not need, such as `workspace` for a directory that runs as
 * it stands.
 */
export type SpawnStepName =
  | 'claim'
  | 'host'
  | 'workspace'
  | 'project-settings'
  | 'trust'
  | 'record'
  | 'reach'
  | 'bridge'
  | 'harness'
  | 'list'
  | 'harness-start'
  | 'auth-ready'
  | 'answer';

/**
 * Runs one step of a spawn and resolves with what it returned. The undo,
 * when given, takes back what the step did; it gets the step's result and
 * the failure that ended the spawn. A step that fails takes back its own
 * partial work before it throws, so only the steps before it are undone.
 */
export interface SpawnSteps {
  readonly run: <T>(
    name: SpawnStepName,
    run: () => Promise<T> | T,
    undo?: (result: T, failure: unknown) => Promise<void> | void,
  ) => Promise<T>;
}

/**
 * Runs a spawn's body over its steps; the spawner takes the runner as a
 * dependency, so a test can fail any step.
 */
export type SpawnStepRunner = <T>(
  id: SessionID,
  body: (steps: SpawnSteps) => Promise<T>,
) => Promise<T>;

/**
 * Runs a spawn as a list of steps, each with its undo. When the body
 * throws, the undo of each step that finished runs, last step first, and
 * the body's failure is thrown again. An undo that throws stops the unwind
 * there, so what the steps before it did stays, and throws an
 * `EffectRemainsError` with the undo's failure as its cause: the spawn's
 * effects may still stand.
 */
export async function runSpawnSteps<T>(
  id: SessionID,
  body: (steps: SpawnSteps) => Promise<T>,
): Promise<T> {
  const done: FinishedStep[] = [];

  const steps: SpawnSteps = {
    run: async (name, run, undo) => {
      const result = await run();

      if (undo !== undefined) {
        done.push({ name, undo: (failure) => undo(result, failure) });
      }

      return result;
    },
  };

  try {
    return await body(steps);
  } catch (error) {
    await drainUndos(id, done.toReversed(), error);

    throw error;
  }
}

// A step that finished, with its undo bound to what the step returned.
interface FinishedStep {
  readonly name: SpawnStepName;
  readonly undo: (failure: unknown) => unknown;
}

// Runs each undo in order, and stops at the first one that throws.
async function drainUndos(
  id: SessionID,
  finished: readonly FinishedStep[],
  failure: unknown,
): Promise<void> {
  for (const step of finished) {
    try {
      await step.undo(failure);
    } catch (error) {
      throw new EffectRemainsError(
        `spawn of session ${id} failed and taking back its ${step.name} step failed too`,
        { cause: error },
      );
    }
  }
}
