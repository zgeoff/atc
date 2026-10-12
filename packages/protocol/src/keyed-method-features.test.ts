import { expect, test } from 'bun:test';
import { KEYED_METHOD_FEATURES } from './keyed-method-features';
import { PROCEDURE_TRAITS } from './procedure-traits';

test('it holds a feature for every keyed procedure and for no other method', () => {
  const keyed = [...PROCEDURE_TRAITS]
    .filter(([, traits]) => traits.keyed)
    .map(([method]) => method);

  expect([...KEYED_METHOD_FEATURES.keys()]).toIncludeSameMembers(keyed);
});

test('it pairs each keyed method with the feature that announces its key', () => {
  expect(Object.fromEntries(KEYED_METHOD_FEATURES)).toStrictEqual({
    'session.spawn': 'spawn.idempotency',
    'session.message': 'message.idempotency',
  });
});
