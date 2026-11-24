import { expect, test } from 'bun:test';
import {
  DAEMON_CONTRACT,
  DAEMON_EVENT_SCHEMA,
  FLEET_CONTRACT,
  LOCAL_FLEET_CONTRACT,
} from '@atcx/contract';
import { collectContractSchemas } from './write-contract-schemas';

test('#collectContractSchemas records both fleet contracts under their own prefixes', () => {
  const methods = Object.keys(
    collectContractSchemas({
      DAEMON_CONTRACT,
      DAEMON_EVENT_SCHEMA,
      FLEET_CONTRACT,
      LOCAL_FLEET_CONTRACT,
    }).procedures,
  );

  expect(methods).toIncludeAllMembers([
    'session.spawn',
    'fleet:session.spawn',
    'fleet:daemons.list',
    'fleet-local:session.spawn',
  ]);
});

test('#collectContractSchemas records daemons.list for the gateway contract alone', () => {
  const methods = Object.keys(
    collectContractSchemas({
      DAEMON_CONTRACT,
      DAEMON_EVENT_SCHEMA,
      FLEET_CONTRACT,
      LOCAL_FLEET_CONTRACT,
    }).procedures,
  );

  expect(methods).not.toContain('fleet-local:daemons.list');
});

test('#collectContractSchemas records no fleet procedure for a release that has no fleet contract', () => {
  const methods = Object.keys(
    collectContractSchemas({
      DAEMON_CONTRACT,
      DAEMON_EVENT_SCHEMA,
    }).procedures,
  );

  expect(methods.filter((method) => method.includes(':'))).toStrictEqual([]);
});

test('#collectContractSchemas records the fleet spawn input with a required idempotency key', () => {
  const input = collectContractSchemas({
    DAEMON_CONTRACT,
    DAEMON_EVENT_SCHEMA,
    FLEET_CONTRACT,
    LOCAL_FLEET_CONTRACT,
  }).procedures['fleet:session.spawn']?.input;

  expect(input).toMatchObject({ required: expect.arrayContaining(['idempotencyKey']) });
});

test('#collectContractSchemas records the gateway session id of the fleet spawn answer as a string', () => {
  const output = collectContractSchemas({
    DAEMON_CONTRACT,
    DAEMON_EVENT_SCHEMA,
    FLEET_CONTRACT,
    LOCAL_FLEET_CONTRACT,
  }).procedures['fleet:session.spawn']?.output;

  expect(output).toMatchObject({
    properties: { session: { properties: { id: { type: 'string' } } } },
  });
});

test('#collectContractSchemas records the entry schema of the agents answer for each daemon name', () => {
  const output = collectContractSchemas({
    DAEMON_CONTRACT,
    DAEMON_EVENT_SCHEMA,
    FLEET_CONTRACT,
    LOCAL_FLEET_CONTRACT,
  }).procedures['fleet:agents.list']?.output;

  expect(output).toMatchObject({
    properties: { daemons: { additionalProperties: { anyOf: expect.any(Array) } } },
  });
});
