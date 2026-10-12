import { expect, test } from 'bun:test';
import { DaemonError } from '../protocol/daemon-error';
import { DAEMON_FEATURES } from '../protocol/daemon-features';
import { buildStubFleetCaller } from './build-stub-fleet-caller';

test('it answers every request with an empty record by default', () => {
  const caller = buildStubFleetCaller();

  expect(caller.sendRequest('session.list')).resolves.toStrictEqual({});
});

test('it reports every feature a current daemon announces by default', () => {
  const caller = buildStubFleetCaller();

  expect(caller.readFeatures()).resolves.toStrictEqual(new Set(DAEMON_FEATURES));
});

test('it reports the features the config gives', () => {
  const caller = buildStubFleetCaller({ features: ['note.get', 'fleet.daemons'] });

  expect(caller.readFeatures()).resolves.toStrictEqual(new Set(['note.get', 'fleet.daemons']));
});

test('it records each request with the arguments the sender passed, in order', async () => {
  const caller = buildStubFleetCaller();

  await caller.sendRequest('session.list');
  await caller.sendRequest('session.spawn', { cwd: '/tmp' }, ['spawn.target'], 'client-a');

  expect(caller.requests).toStrictEqual([
    { m: 'session.list' },
    { m: 'session.spawn', p: { cwd: '/tmp' }, required: ['spawn.target'], principal: 'client-a' },
  ]);
});

test('it replies with what the answer gives for the request', () => {
  const caller = buildStubFleetCaller({
    answer: (request) => ({ echoed: request.p?.['text'] }),
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

  expect(caller.requests).toStrictEqual([{ m: 'session.get', p: { session: 's1' } }]);
});
