import { expect, test } from 'bun:test';
import { parseDeclaredScope } from './parse-declared-scope';

test('it reads a scope with an entry of every kind', () => {
  expect(
    parseDeclaredScope({
      worktrees: [{ path: '/src/app/.worktrees/fix' }],
      branches: [{ name: 'fix', repo: '/src/app' }, { name: 'main' }],
      pullRequests: [{ number: 42, repo: 'me/app' }, { number: 7 }],
    }),
  ).toStrictEqual({
    ok: true,
    scope: {
      worktrees: [{ path: '/src/app/.worktrees/fix' }],
      branches: [{ name: 'fix', repo: '/src/app' }, { name: 'main' }],
      pullRequests: [{ number: 42, repo: 'me/app' }, { number: 7 }],
    },
  });
});

test('it reads an empty scope as no entries', () => {
  expect(parseDeclaredScope({})).toStrictEqual({
    ok: true,
    scope: { worktrees: [], branches: [], pullRequests: [] },
  });
});

test.each([
  [
    'an unknown key at the top',
    { worktrees: [{ path: '/src/app' }], notes: 'free text' },
    'scope.notes',
  ],
  [
    'an unknown key in an entry',
    { worktrees: [{ path: '/src/app', why: 'it is mine' }] },
    'scope.worktrees[0]',
  ],
  [
    'a relative worktree path',
    { worktrees: [{ path: '/src/app' }, { path: 'src/app' }] },
    'scope.worktrees[1]',
  ],
  [
    'a worktree path with a .. segment',
    { worktrees: [{ path: '/src/../etc' }] },
    'scope.worktrees[0]',
  ],
  ['a branch name that starts with -', { branches: [{ name: '--force' }] }, 'scope.branches[0]'],
  ['a branch name with a newline', { branches: [{ name: 'a\nb' }] }, 'scope.branches[0]'],
  [
    'a pull request number that is not whole',
    { pullRequests: [{ number: 1.5 }] },
    'scope.pullRequests[0]',
  ],
  [
    'a pull request repo that is a URL',
    { pullRequests: [{ number: 3, repo: 'https://github.com/me/app' }] },
    'scope.pullRequests[0]',
  ],
  ['a list that is not an array', { branches: 'main' }, 'scope.branches'],
  ['a scope that is a string', 'everything under /src', 'scope'],
])('it refuses %s and holds the entry', (_label, raw, entry) => {
  expect(parseDeclaredScope(raw)).toStrictEqual({
    ok: false,
    entry,
    message: expect.toStartWith(`${entry} is invalid: `),
  });
});

test('it refuses a list longer than 64 entries', () => {
  const worktrees = Array.from({ length: 65 }, (_, index) => ({ path: `/w/${index}` }));

  expect(parseDeclaredScope({ worktrees })).toStrictEqual({
    ok: false,
    entry: 'scope.worktrees',
    message: 'scope.worktrees is invalid: worktrees holds at most 64 entries',
  });
});

test('it refuses a key a scope does not define with the keys it holds', () => {
  expect(parseDeclaredScope({ notes: 'anything under ~/src' })).toStrictEqual({
    ok: false,
    entry: 'scope.notes',
    message: 'scope.notes is invalid: a scope holds only worktrees, branches, and pullRequests',
  });
});

test('it refuses a key an entry does not define with the keys its kind holds', () => {
  expect(parseDeclaredScope({ branches: [{ name: 'main', why: 'mine' }] })).toStrictEqual({
    ok: false,
    entry: 'scope.branches[0]',
    message: 'scope.branches[0] is invalid: a branch holds only name and repo',
  });
});

test('it refuses a scope that is not an object', () => {
  expect(parseDeclaredScope('everything under /src')).toStrictEqual({
    ok: false,
    entry: 'scope',
    message: 'scope is invalid: scope must be an object',
  });
});

test('it refuses an entry that is not an object', () => {
  expect(parseDeclaredScope({ worktrees: ['/src/app'] })).toStrictEqual({
    ok: false,
    entry: 'scope.worktrees[0]',
    message: 'scope.worktrees[0] is invalid: an entry must be an object',
  });
});
