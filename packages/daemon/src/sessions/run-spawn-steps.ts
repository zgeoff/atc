import { EffectRemainsError } from '@atc/plugin-api';
import type { SessionID } from '@atcx/contract';

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

// a step that fails takes back its own partial work before it throws: only
// the steps before it are undone
export interface SpawnSteps {
  readonly run: <T>(
    name: SpawnStepName,
    run: () => Promise<T> | T,
    undo?: (result: T, failure: unknown) => Promise<void> | void,
  ) => Promise<T>;

  // runs in the caller's turn, so steps that must not let a microtask in
  // between (starting a harness and booting its session) follow at once
  readonly runNow: <T>(
    name: SpawnStepName,
    run: () => T,
    undo?: (result: T, failure: unknown) => Promise<void> | void,
  ) => T;
}

export type SpawnStepRunner = <T>(
  id: SessionID,
  body: (steps: SpawnSteps) => Promise<T>,
) => Promise<T>;

// A step that finished, with its undo bound to what the step returned.
interface FinishedStep {
  readonly name: SpawnStepName;
  readonly undo: (failure: unknown) => unknown;
}

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
    runNow: (name, run, undo) => {
      const result = run();

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
