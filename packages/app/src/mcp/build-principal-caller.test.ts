import { expect, test } from 'bun:test';
import { buildStubFleetCaller } from '../test-utils/build-stub-fleet-caller';
import { buildPrincipalCaller } from './build-principal-caller';

const CLIENT = { id: 'client-a', name: 'Lantern Notes' };

test('it sends a request as the principal, only to a daemon that limits it to that principal and labels its messages with the name', async () => {
  const caller = buildStubFleetCaller();

  await buildPrincipalCaller(caller, CLIENT).sendRequest('session.list');

  expect(caller.requests).toStrictEqual([
    {
      m: 'session.list',
      required: ['request.principal', 'message.sender'],
      principal: { id: 'client-a', name: 'Lantern Notes' },
    },
  ]);
});

test('it sends a request as the principal over the principal the request asks for, keeping the features it requires', async () => {
  const caller = buildStubFleetCaller();

  await buildPrincipalCaller(caller, CLIENT).sendRequest(
    'session.spawn',
    { cwd: '/tmp' },
    ['spawn.target'],
    { id: 'client-b', name: 'Tide Charts' },
  );

  expect(caller.requests).toStrictEqual([
    {
      m: 'session.spawn',
      p: { cwd: '/tmp' },
      required: ['spawn.target', 'request.principal', 'message.sender'],
      principal: { id: 'client-a', name: 'Lantern Notes' },
    },
  ]);
});

test('it reports the features of the daemon behind it', () => {
  const caller = buildStubFleetCaller({ features: ['note.get'] });

  expect(buildPrincipalCaller(caller, CLIENT).readFeatures()).resolves.toStrictEqual(
    new Set(['note.get']),
  );
});
