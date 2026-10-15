import { expect, mock, test } from 'bun:test';
import { toSessionID } from '@atc/core';
import { EffectRemainsError } from '@atc/plugin-api';
import { runSpawnSteps } from './run-spawn-steps';

test('it resolves with what the body returns and runs no undo', async () => {
  const undo = mock();

  const answer = await runSpawnSteps(toSessionID('s-ok'), async (steps) => {
    await steps.run('claim', () => 'claimed', undo);

    return 'listed';
  });

  expect(answer).toBe('listed');
  expect(undo).not.toHaveBeenCalled();
});

test("it undoes each finished step, last first, with the step's result and the failure", async () => {
  const undone: string[] = [];

  const failure = new Error('the record could not be placed');

  const spawned = runSpawnSteps(toSessionID('s-failed'), async (steps) => {
    await steps.run(
      'claim',
      () => '/work/claimed',
      (result, cause) => {
        undone.push(`claim:${result}:${String(cause === failure)}`);
      },
    );

    await steps.run(
      'host',
      () => Promise.resolve('host-7'),
      (result, cause) => {
        undone.push(`host:${result}:${String(cause === failure)}`);
      },
    );

    await steps.run('reach', () => {});
    await steps.run('record', () => Promise.reject(failure));

    return 'listed';
  });

  await spawned.catch(() => null);

  expect(spawned).rejects.toBe(failure);
  expect(undone).toStrictEqual(['host:host-7:true', 'claim:/work/claimed:true']);
});

test('it never undoes the step that failed', async () => {
  const undo = mock();

  const spawned = runSpawnSteps(toSessionID('s-failed'), (steps) =>
    steps.run('bridge', () => Promise.reject(new Error('bridge refused')), undo),
  );

  await spawned.catch(() => null);

  expect(spawned).rejects.toThrowWithMessage(Error, 'bridge refused');
  expect(undo).not.toHaveBeenCalled();
});

test('it stops the unwind at an undo that throws and throws that the spawn may still stand', async () => {
  const claimUndo = mock();

  const stuck = new Error('the harness did not exit');

  const spawned = runSpawnSteps(toSessionID('s-stuck'), async (steps) => {
    await steps.run('claim', () => {}, claimUndo);

    await steps.run(
      'harness',
      () => {},
      () => Promise.reject(stuck),
    );

    throw new Error('the harness never started');
  });

  const thrown = await spawned.catch((error: unknown) => error);

  expect(thrown).toBeInstanceOf(EffectRemainsError);

  expect(thrown).toMatchObject({
    message: 'spawn of session s-stuck failed and taking back its harness step failed too',
    cause: stuck,
  });

  expect(claimUndo).not.toHaveBeenCalled();
});
