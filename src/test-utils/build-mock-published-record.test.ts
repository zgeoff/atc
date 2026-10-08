import { expect, test } from 'bun:test';
import { buildMockPublishedRecord } from './build-mock-published-record';

test('it builds a default published record', () => {
  expect(buildMockPublishedRecord()).toStrictEqual({
    format: 'atc.session-record',
    version: 1,
    session: expect.toBeString(),
    daemonID: expect.toBeString(),
    target: 'local',
    revision: 1,
    updatedAt: expect.toBeDateString(),
    scope: {
      workspace: {
        path: expect.toStartWith('/'),
        branch: expect.toBeString(),
        repoURL: null,
        sha: null,
      },
      worktrees: [],
      branches: [],
      pullRequests: [],
    },
  });
});

test('it applies overrides on top of the defaults', () => {
  expect(
    buildMockPublishedRecord({
      session: 's-kept',
      revision: 3,
      scope: {
        workspace: { branch: null },
        branches: [{ name: 'fix', repo: '/src/app' }],
      },
    }),
  ).toStrictEqual({
    format: 'atc.session-record',
    version: 1,
    session: 's-kept',
    daemonID: expect.toBeString(),
    target: 'local',
    revision: 3,
    updatedAt: expect.toBeDateString(),
    scope: {
      workspace: { path: expect.toStartWith('/'), branch: null, repoURL: null, sha: null },
      worktrees: [],
      branches: [{ name: 'fix', repo: '/src/app' }],
      pullRequests: [],
    },
  });
});
