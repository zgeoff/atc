import { expect, test } from 'bun:test';
import { mergeRecordedScope } from './merge-recorded-scope';

test('it appends each entry the recorded scope lacks after the ones it holds', () => {
  expect(
    mergeRecordedScope(
      {
        workspace: { path: '/src/app', branch: 'main', repoURL: null, sha: null },
        worktrees: [{ path: '/src/app/.worktrees/a', branch: 'a' }],
        branches: [{ name: 'a', repo: '/src/app' }],
        pullRequests: [
          { repo: 'me/app', number: 1, url: 'https://github.com/me/app/pull/1', branch: 'a' },
        ],
      },
      {
        worktrees: [{ path: '/src/app/.worktrees/b', branch: 'b' }],
        branches: [{ name: 'b', repo: '/src/app' }],
        pullRequests: [
          { repo: 'me/app', number: 2, url: 'https://github.com/me/app/pull/2', branch: 'b' },
        ],
      },
    ),
  ).toStrictEqual({
    workspace: { path: '/src/app', branch: 'main', repoURL: null, sha: null },
    worktrees: [
      { path: '/src/app/.worktrees/a', branch: 'a' },
      { path: '/src/app/.worktrees/b', branch: 'b' },
    ],
    branches: [
      { name: 'a', repo: '/src/app' },
      { name: 'b', repo: '/src/app' },
    ],
    pullRequests: [
      { repo: 'me/app', number: 1, url: 'https://github.com/me/app/pull/1', branch: 'a' },
      { repo: 'me/app', number: 2, url: 'https://github.com/me/app/pull/2', branch: 'b' },
    ],
  });
});

test('it returns the recorded scope itself when every entry is already there', () => {
  const recorded = {
    workspace: { path: '/src/app', branch: 'main', repoURL: null, sha: null },
    worktrees: [{ path: '/src/app/.worktrees/a', branch: 'a' }],
    branches: [{ name: 'a', repo: '/src/app' }],
    pullRequests: [
      { repo: 'me/app', number: 1, url: 'https://github.com/me/app/pull/1', branch: 'a' },
    ],
  };

  expect(
    mergeRecordedScope(recorded, {
      worktrees: [{ path: '/src/app/.worktrees/a', branch: 'a' }],
      branches: [{ name: 'a', repo: '/src/app' }],
      pullRequests: [
        { repo: 'Me/App', number: 1, url: 'https://github.com/Me/App/pull/1', branch: 'a' },
      ],
    }),
  ).toBe(recorded);
});

test('it keeps a branch of the same name in another repository as its own entry', () => {
  expect(
    mergeRecordedScope(
      {
        workspace: { path: '/src/app', branch: null, repoURL: null, sha: null },
        worktrees: [],
        branches: [{ name: 'main', repo: '/src/app' }],
        pullRequests: [],
      },
      { worktrees: [], branches: [{ name: 'main', repo: '/src/lib' }], pullRequests: [] },
    ).branches,
  ).toStrictEqual([
    { name: 'main', repo: '/src/app' },
    { name: 'main', repo: '/src/lib' },
  ]);
});

test('it adds an entry once when the added scope repeats it', () => {
  expect(
    mergeRecordedScope(
      {
        workspace: { path: '/src/app', branch: null, repoURL: null, sha: null },
        worktrees: [],
        branches: [],
        pullRequests: [],
      },
      {
        worktrees: [
          { path: '/w', branch: 'x' },
          { path: '/w', branch: 'x' },
        ],
        branches: [],
        pullRequests: [],
      },
    ).worktrees,
  ).toStrictEqual([{ path: '/w', branch: 'x' }]);
});
