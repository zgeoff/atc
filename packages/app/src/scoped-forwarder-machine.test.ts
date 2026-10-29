import { expect, test } from 'bun:test';
import { createActor } from 'xstate';
import { SCOPED_FORWARDER_MACHINE } from './scoped-forwarder-machine';

test('it reads a batch and settles back to idle', () => {
  const actor = createActor(SCOPED_FORWARDER_MACHINE).start();

  actor.send({ type: 'READ' });
  actor.send({ type: 'SETTLE' });

  expect(actor.getSnapshot().value).toBe('idle');
});

test('it stays stopped once stopped while it reads', () => {
  const actor = createActor(SCOPED_FORWARDER_MACHINE).start();

  actor.send({ type: 'READ' });
  actor.send({ type: 'STOP' });
  actor.send({ type: 'SETTLE' });
  actor.send({ type: 'READ' });

  expect(actor.getSnapshot().value).toBe('stopped');
});
