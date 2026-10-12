import { expect, test } from 'bun:test';
import type { PublishedRecord } from '../protocol/published-record';
import { parsePublishedRecord } from './parse-published-record';

test('it reads back a version 1 record', () => {
  const record: PublishedRecord = {
    format: 'atc.session-record',
    version: 1,
    session: 's-1',
    daemonID: 'd-1',
    target: 'box',
    revision: 2,
    updatedAt: '2026-10-08T09:30:00.000Z',
    scope: {
      workspace: {
        path: '/src/app',
        branch: 'main',
        repoURL: 'https://github.com/me/app.git',
        sha: 'a'.repeat(40),
      },
      worktrees: [{ path: '/src/app/.worktrees/fix', branch: null }],
      branches: [{ name: 'fix', repo: '/src/app' }],
      pullRequests: [
        { repo: 'me/app', number: 4, url: 'https://github.com/me/app/pull/4', branch: 'fix' },
      ],
    },
  };

  expect(parsePublishedRecord(JSON.stringify(record))).toStrictEqual(record);
});

test('it reads text that is not JSON as no record', () => {
  expect(parsePublishedRecord('{"format":')).toBeNull();
});

test('it reads a record of another version as no record', () => {
  expect(
    parsePublishedRecord(
      JSON.stringify({
        format: 'atc.session-record',
        version: 2,
        session: 's-1',
        daemonID: 'd-1',
        target: 'box',
        revision: 2,
        updatedAt: '2026-10-08T09:30:00.000Z',
        scope: {
          workspace: { path: '/src/app', branch: 'main', repoURL: null, sha: null },
          worktrees: [],
          branches: [],
          pullRequests: [],
        },
      }),
    ),
  ).toBeNull();
});
