import { expect, test } from 'bun:test';
import { EXECUTION_TARGET_CONFIG_SCHEMA } from './execution-target-config';

test('it reads a target slice with its id, options, and environment', () => {
  const payload = { id: 'box', options: { url: 'http://127.0.0.1:9' }, env: { DEBUG: '1' } };

  expect(EXECUTION_TARGET_CONFIG_SCHEMA.safeParse(payload).data).toStrictEqual(payload);
});

test('it refuses a slice whose options are not an object', () => {
  const result = EXECUTION_TARGET_CONFIG_SCHEMA.safeParse({ id: 'box', options: 'x', env: {} });

  expect(result.error?.issues).toPartiallyContain({ path: ['options'] });
});
