import { expect, onTestFinished, test } from 'bun:test';
import { createActor } from 'xstate';
import { TRANSPORT_MACHINE } from './transport-machine';
import type { TransportReconnect } from './transport-machine';

interface SetupConfig {
  readonly reconnect: TransportReconnect;
}

/**
 * A started actor of the machine for the given reconnect mode, stopped
 * once the test ends.
 */
function setupTest(config: SetupConfig) {
  const actor = createActor(TRANSPORT_MACHINE, { input: { reconnect: config.reconnect } }).start();

  onTestFinished(() => {
    actor.stop();
  });

  return { actor };
}

test('it starts idle with no failures counted', () => {
  const ctx = setupTest({ reconnect: 'on-demand' });

  expect(ctx.actor.getSnapshot().value).toBe('idle');
  expect(ctx.actor.getSnapshot().context.failures).toBe(0);
});

test('it is ready once a requested connection opens', () => {
  const ctx = setupTest({ reconnect: 'on-demand' });

  ctx.actor.send({ type: 'CONNECT' });
  ctx.actor.send({ type: 'OPENED' });

  expect(ctx.actor.getSnapshot().value).toBe('ready');
});

test('it goes back to idle when an on-demand open fails', () => {
  const ctx = setupTest({ reconnect: 'on-demand' });

  ctx.actor.send({ type: 'CONNECT' });
  ctx.actor.send({ type: 'OPEN_FAILED', fatal: false });

  expect(ctx.actor.getSnapshot().value).toBe('idle');
});

test('it goes back to idle when an on-demand connection is lost', () => {
  const ctx = setupTest({ reconnect: 'on-demand' });

  ctx.actor.send({ type: 'CONNECT' });
  ctx.actor.send({ type: 'OPENED' });
  ctx.actor.send({ type: 'LOST' });

  expect(ctx.actor.getSnapshot().value).toBe('idle');
});

test('it backs off and counts the failure when an always open fails', () => {
  const ctx = setupTest({ reconnect: 'always' });

  ctx.actor.send({ type: 'CONNECT' });
  ctx.actor.send({ type: 'OPEN_FAILED', fatal: false });
  ctx.actor.send({ type: 'RETRY' });
  ctx.actor.send({ type: 'OPEN_FAILED', fatal: false });

  expect(ctx.actor.getSnapshot().value).toBe('backoff');
  expect(ctx.actor.getSnapshot().context.failures).toBe(2);
});

test('it opens again after a backoff and clears the failures once ready', () => {
  const ctx = setupTest({ reconnect: 'always' });

  ctx.actor.send({ type: 'CONNECT' });
  ctx.actor.send({ type: 'OPEN_FAILED', fatal: false });
  ctx.actor.send({ type: 'RETRY' });
  ctx.actor.send({ type: 'OPENED' });

  expect(ctx.actor.getSnapshot().value).toBe('ready');
  expect(ctx.actor.getSnapshot().context.failures).toBe(0);
});

test('it backs off without counting a failure when an always connection is lost', () => {
  const ctx = setupTest({ reconnect: 'always' });

  ctx.actor.send({ type: 'CONNECT' });
  ctx.actor.send({ type: 'OPENED' });
  ctx.actor.send({ type: 'LOST' });

  expect(ctx.actor.getSnapshot().value).toBe('backoff');
  expect(ctx.actor.getSnapshot().context.failures).toBe(0);
});

test('it closes for good on a fatal open failure', () => {
  const ctx = setupTest({ reconnect: 'always' });

  ctx.actor.send({ type: 'CONNECT' });
  ctx.actor.send({ type: 'OPEN_FAILED', fatal: true });
  ctx.actor.send({ type: 'CONNECT' });

  expect(ctx.actor.getSnapshot().value).toBe('closed');
  expect(ctx.actor.getSnapshot().status).toBe('done');
});

test.each([
  ['idle', []],
  ['connecting', [{ type: 'CONNECT' }]],
  ['ready', [{ type: 'CONNECT' }, { type: 'OPENED' }]],
  ['backoff', [{ type: 'CONNECT' }, { type: 'OPEN_FAILED', fatal: false }]],
] as const)('it closes for good when stopped while %s', (_state, events) => {
  const ctx = setupTest({ reconnect: 'always' });

  for (const event of events) {
    ctx.actor.send(event);
  }

  ctx.actor.send({ type: 'STOP' });

  expect(ctx.actor.getSnapshot().value).toBe('closed');
});

test('it ignores a request for a connection while one opens or a backoff runs', () => {
  const ctx = setupTest({ reconnect: 'always' });

  ctx.actor.send({ type: 'CONNECT' });
  ctx.actor.send({ type: 'CONNECT' });
  ctx.actor.send({ type: 'OPEN_FAILED', fatal: false });
  ctx.actor.send({ type: 'CONNECT' });

  expect(ctx.actor.getSnapshot().value).toBe('backoff');
});
