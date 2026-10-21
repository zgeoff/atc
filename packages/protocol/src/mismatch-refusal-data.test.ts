import { expect, test } from 'bun:test';
import { MISMATCH_REFUSAL_DATA_SCHEMA } from './mismatch-refusal-data';

test('it accepts refusal data that holds the daemon protocol', () => {
  const result = MISMATCH_REFUSAL_DATA_SCHEMA.safeParse({ daemonProtocol: 9 });

  expect(result.data).toStrictEqual({ daemonProtocol: 9 });
});

test('it accepts refusal data from a daemon that sends no protocol', () => {
  const result = MISMATCH_REFUSAL_DATA_SCHEMA.safeParse({});

  expect(result.data).toStrictEqual({});
});

test('it rejects a daemon protocol that is not a whole number', () => {
  const result = MISMATCH_REFUSAL_DATA_SCHEMA.safeParse({ daemonProtocol: '9' });

  expect(result.error?.issues).toPartiallyContain({ path: ['daemonProtocol'] });
});
