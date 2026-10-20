// oxlint-disable zgeoff/test-beside-module -- pins the xstate behaviour the spawn picker and imp-harness machines rely on, moved with the picker (GEO-403)
import { expect, mock, onTestFinished, test } from 'bun:test';
import invariant from 'tiny-invariant';
import { assign, createActor, fromPromise, setup, spawnChild, stopChild } from 'xstate';

function setupTest() {
  const requests: PromiseWithResolvers<string>[] = [];
  const onDone = mock();
  const context: { result: string | null } = { result: null };

  const machine = setup({
    types: { context },
    actors: {
      request: fromPromise(() => {
        const request = Promise.withResolvers<string>();

        requests.push(request);

        return request.promise;
      }),
    },
  }).createMachine({
    context,
    initial: 'idle',
    states: {
      idle: { on: { LOAD: 'loading' } },
      loading: {
        entry: spawnChild('request', { id: 'request' }),
        exit: stopChild('request'),
        on: {
          'xstate.done.actor.request': {
            target: 'loaded',
            actions: [
              assign({ result: (args) => String(args.event['output']) }),
              (args) => {
                onDone(String(args.event['output']));
              },
            ],
          },
          LEAVE: 'idle',
        },
      },
      loaded: {},
    },
  });

  const actor = createActor(machine);

  onTestFinished(() => {
    actor.stop();
  });

  actor.start();

  return { actor, requests, onDone };
}

test('it takes the result of a request whose state is still active', async () => {
  const ctx = setupTest();

  ctx.actor.send({ type: 'LOAD' });

  const [request] = ctx.requests;

  invariant(request);

  request.resolve('fresh');

  await request.promise;

  expect(ctx.actor.getSnapshot().value).toBe('loaded');
  expect(ctx.actor.getSnapshot().context.result).toBe('fresh');
  expect(ctx.onDone).toHaveBeenCalledExactlyOnceWith('fresh');
});

test('it drops the result of a request that settles after its state is exited', async () => {
  const ctx = setupTest();

  ctx.actor.send({ type: 'LOAD' });

  const child = ctx.actor.getSnapshot().children['request'];
  const [request] = ctx.requests;

  invariant(child);
  invariant(request);

  ctx.actor.send({ type: 'LEAVE' });
  request.resolve('stale');

  await request.promise;

  expect(child.getSnapshot().status).toBe('stopped');
  expect(ctx.actor.getSnapshot().value).toBe('idle');
  expect(ctx.actor.getSnapshot().context.result).toBeNull();
  expect(ctx.onDone).not.toHaveBeenCalled();
});

test('it drops the result of an earlier request after its state is entered again', async () => {
  const ctx = setupTest();

  ctx.actor.send({ type: 'LOAD' });
  ctx.actor.send({ type: 'LEAVE' });
  ctx.actor.send({ type: 'LOAD' });

  const [earlier] = ctx.requests;

  invariant(earlier);

  earlier.resolve('stale');

  await earlier.promise;

  expect(ctx.requests).toHaveLength(2);
  expect(ctx.actor.getSnapshot().value).toBe('loading');
  expect(ctx.actor.getSnapshot().context.result).toBeNull();
  expect(ctx.onDone).not.toHaveBeenCalled();
});
