import { expect, test } from 'bun:test';
import { REQUEST_PARAM_SCHEMAS } from './request-param-schemas';

test('it reads the atc scopes a spawn grants its session', () => {
  const result = REQUEST_PARAM_SCHEMAS['session.spawn'].safeParse({
    cwd: '/work/repo',
    atcAccess: ['read', 'kill'],
  });

  expect(result.data?.atcAccess).toStrictEqual(['read', 'kill']);
});

test.each<{ label: string; atcAccess: unknown; path: (string | number)[] }>([
  { label: 'a scope atc does not know', atcAccess: ['read', 'admin'], path: ['atcAccess', 1] },
  { label: 'a scope in another case', atcAccess: ['Read'], path: ['atcAccess', 0] },
  { label: 'an empty scope name', atcAccess: [''], path: ['atcAccess', 0] },
  { label: 'a wildcard scope', atcAccess: ['*'], path: ['atcAccess', 0] },
  { label: 'a scope that is not a string', atcAccess: [1], path: ['atcAccess', 0] },
  { label: 'one scope twice', atcAccess: ['read', 'read'], path: ['atcAccess'] },
  {
    label: 'more scopes than atc has',
    atcAccess: ['read', 'message', 'spawn', 'kill', 'read'],
    path: ['atcAccess'],
  },
  { label: 'a scope string in place of a list', atcAccess: 'read', path: ['atcAccess'] },
])('it refuses a spawn that grants $label', (row) => {
  const result = REQUEST_PARAM_SCHEMAS['session.spawn'].safeParse({
    cwd: '/work/repo',
    atcAccess: row.atcAccess,
  });

  expect(result.error?.issues).toPartiallyContain({ path: row.path });
});
