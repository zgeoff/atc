import { expect, test } from 'bun:test';
import { REQUEST_PARAM_SCHEMAS } from './request-param-schemas';

test('it reads the atc scopes a spawn grants its session', () => {
  const result = REQUEST_PARAM_SCHEMAS['session.spawn'].safeParse({
    cwd: '/work/repo',
    atcAccess: ['read', 'kill'],
  });

  expect(result.data?.atcAccess).toStrictEqual(['read', 'kill']);
});

test('it refuses a spawn that grants a scope atc does not know', () => {
  const result = REQUEST_PARAM_SCHEMAS['session.spawn'].safeParse({
    cwd: '/work/repo',
    atcAccess: ['read', 'admin'],
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['atcAccess', 1] });
});

test('it refuses a spawn that grants one scope twice', () => {
  const result = REQUEST_PARAM_SCHEMAS['session.spawn'].safeParse({
    cwd: '/work/repo',
    atcAccess: ['read', 'read'],
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['atcAccess'] });
});
