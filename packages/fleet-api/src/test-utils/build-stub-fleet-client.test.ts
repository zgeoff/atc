import { expect, test } from 'bun:test';
import { buildStubFleetClient } from './build-stub-fleet-client';

test('it records the input of each call with its method', async () => {
  const stub = buildStubFleetClient();

  await stub.client.session.scope.add({ session: 's1', scope: 'read' });

  expect(stub.calls).toStrictEqual([
    { method: 'session.scope.add', input: { session: 's1', scope: 'read' } },
  ]);
});

test('it holds the daemons procedure only when asked', () => {
  expect(buildStubFleetClient().client.daemons).toBeUndefined();
  expect(buildStubFleetClient({ hasDaemons: true }).client.daemons).toBeDefined();
});
