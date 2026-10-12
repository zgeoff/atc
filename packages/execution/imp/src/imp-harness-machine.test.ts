import { expect, onTestFinished, test } from 'bun:test';
import { DaemonError } from '@atc/protocol/daemon-error';
import { createActor } from 'xstate';
import { IMP_HARNESS_MACHINE } from './imp-harness-machine';

/**
 * A started actor of the machine, stopped once the test ends.
 */
function setupTest() {
  const actor = createActor(IMP_HARNESS_MACHINE).start();

  onTestFinished(() => {
    actor.stop();
  });

  return { actor };
}

test('it starts following with no started connection, nothing sent, and its start pending', () => {
  const ctx = setupTest();

  expect(ctx.actor.getSnapshot().value).toStrictEqual({
    run: {
      following: { connection: 'waiting', process: 'unsent', screen: 'resuming', kill: 'none' },
    },
    start: 'pending',
  });
});

test('it resumes the screen, takes the waiting kill, and settles the start when a connection starts', () => {
  const ctx = setupTest();

  ctx.actor.send({ type: 'START_SENT' });
  ctx.actor.send({ type: 'FRESH_REQUESTED' });
  ctx.actor.send({ type: 'KILL_REQUESTED' });
  ctx.actor.send({ type: 'CONNECTION_STARTED' });

  expect(ctx.actor.getSnapshot().value).toStrictEqual({
    run: {
      following: { connection: 'live', process: 'sent', screen: 'resuming', kill: 'none' },
    },
    start: 'started',
  });
});

test('it waits for the next connection after a started one ends', () => {
  const ctx = setupTest();

  ctx.actor.send({ type: 'CONNECTION_STARTED' });
  ctx.actor.send({ type: 'CONNECTION_ENDED' });

  expect(ctx.actor.getSnapshot().matches({ run: { following: { connection: 'waiting' } } })).toBe(
    true,
  );
});

test('it confirms the exit and refuses the start when the harness ends with an exit before it started', () => {
  const ctx = setupTest();

  const refusal = new DaemonError('host_unavailable', 'imp ended the harness before it started');

  ctx.actor.send({ type: 'END', confirmed: true, refusal });

  expect(ctx.actor.getSnapshot().value).toStrictEqual({
    run: { ended: 'exited' },
    start: 'refused',
  });

  expect(ctx.actor.getSnapshot().context.refusal).toBe(refusal);
});

test('it leaves the exit unconfirmed when the harness ends with nothing to confirm it', () => {
  const ctx = setupTest();

  ctx.actor.send({
    type: 'END',
    confirmed: false,
    refusal: new DaemonError('host_unavailable', 'the daemon let go of the harness'),
  });

  expect(ctx.actor.getSnapshot().matches({ run: { ended: 'unconfirmed' } })).toBe(true);
});

test('it keeps a start that started when the harness ends', () => {
  const ctx = setupTest();

  ctx.actor.send({ type: 'CONNECTION_STARTED' });

  ctx.actor.send({
    type: 'END',
    confirmed: true,
    refusal: new DaemonError('host_unavailable', 'imp ended the harness before it started'),
  });

  expect(ctx.actor.getSnapshot().matches({ start: 'started' })).toBe(true);
  expect(ctx.actor.getSnapshot().context.refusal).toBeNull();
});

test('it ignores a second end and every event after the first', () => {
  const ctx = setupTest();

  const refusal = new DaemonError('host_unavailable', 'imp ended the harness before it started');

  ctx.actor.send({ type: 'END', confirmed: true, refusal });

  ctx.actor.send({
    type: 'END',
    confirmed: false,
    refusal: new DaemonError('host_unavailable', 'the daemon let go of the harness'),
  });

  ctx.actor.send({ type: 'KILL_REQUESTED' });
  ctx.actor.send({ type: 'CONNECTION_STARTED' });

  expect(ctx.actor.getSnapshot().value).toStrictEqual({
    run: { ended: 'exited' },
    start: 'refused',
  });

  expect(ctx.actor.getSnapshot().context.refusal).toBe(refusal);
});
