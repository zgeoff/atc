import { expect, test } from 'bun:test';
import { buildStubFleetCaller } from '@atc/fleet-api/test-utils/build-stub-fleet-caller';
import { createTestFleetClient } from './create-test-fleet-client';

test('it serves the gateway contract to a caller that routes across daemons', () => {
  const client = createTestFleetClient(buildStubFleetCaller({ features: ['fleet.daemons'] }));

  expect(client.daemons).toBeDefined();
});

test('it serves the local contract to a caller of one daemon', () => {
  const client = createTestFleetClient(buildStubFleetCaller());

  expect(client.daemons).toBeUndefined();
});

test('it calls the daemon as the principal it is given', async () => {
  const caller = buildStubFleetCaller({ answer: () => ({ stopped: true }) });
  const principal = { id: 'ops', name: 'ops-console' };

  await createTestFleetClient(caller, principal).session.kill({ session: 's1' });

  expect(caller.requests[0]?.principal).toStrictEqual(principal);
});
