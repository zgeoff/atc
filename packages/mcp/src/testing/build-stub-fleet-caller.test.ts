import { expect, test } from 'bun:test';
import { DaemonError } from '@atc/protocol/wire';
import { buildStubFleetCaller } from './build-stub-fleet-caller';

test('it answers every request with an empty record by default', () => {
  const caller = buildStubFleetCaller();

  expect(caller.sendRequest('session.list')).resolves.toStrictEqual({});
});

test('it reports no features by default', () => {
  const caller = buildStubFleetCaller();

  expect(caller.features).toStrictEqual(new Set());
});

test('it reports the features the config gives', () => {
  const caller = buildStubFleetCaller({ features: ['fleet.daemons'] });

  expect(caller.features).toStrictEqual(new Set(['fleet.daemons']));
});

test('it records each request with the arguments the sender passed, in order', async () => {
  const caller = buildStubFleetCaller();

  await caller.sendRequest('session.list');

  await caller.sendRequest(
    'session.spawn',
    { cwd: '/tmp' },
    { id: 'client-a', name: 'Lantern Notes' },
  );

  expect(caller.requests).toStrictEqual([
    { method: 'session.list' },
    {
      method: 'session.spawn',
      params: { cwd: '/tmp' },
      principal: { id: 'client-a', name: 'Lantern Notes' },
    },
  ]);
});

test('it replies with what the answer gives for the request', () => {
  const caller = buildStubFleetCaller({
    answer: (request) => ({ echoed: request.params?.['text'] }),
  });

  expect(caller.sendRequest('session.message', { text: 'hi' })).resolves.toStrictEqual({
    echoed: 'hi',
  });
});

test('it rejects a request whose answer throws', () => {
  const caller = buildStubFleetCaller({
    answer: () => {
      throw new DaemonError('no_such_session', 'gone');
    },
  });

  expect(caller.sendRequest('session.get', { session: 's1' })).rejects.toMatchObject({
    code: 'no_such_session',
  });
});

test('it records a request whose answer throws', async () => {
  const caller = buildStubFleetCaller({
    answer: () => {
      throw new DaemonError('no_such_session', 'gone');
    },
  });

  await caller.sendRequest('session.get', { session: 's1' }).catch(() => null);

  expect(caller.requests).toStrictEqual([{ method: 'session.get', params: { session: 's1' } }]);
});
