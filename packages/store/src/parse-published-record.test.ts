import { expect, test } from 'bun:test';
import type { PublishedRecord } from '@atc/protocol';
import { z } from 'zod';
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
    name: 'login fix',
    transcriptPath: '/home/dev/.claude/projects/app/4d2c.jsonl',
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

test('it reads a record stored without a name or a transcript path as holding neither', () => {
  const parsed = parsePublishedRecord(
    JSON.stringify({
      format: 'atc.session-record',
      version: 1,
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
  );

  expect(parsed).toStrictEqual({
    format: 'atc.session-record',
    version: 1,
    session: 's-1',
    daemonID: 'd-1',
    target: 'box',
    revision: 2,
    updatedAt: '2026-10-08T09:30:00.000Z',
    name: null,
    transcriptPath: null,
    scope: {
      workspace: { path: '/src/app', branch: 'main', repoURL: null, sha: null },
      worktrees: [],
      branches: [],
      pullRequests: [],
    },
  });
});

test('it gives a reader of the version 1 format before the name and transcript path a record it parses', () => {
  const record: PublishedRecord = {
    format: 'atc.session-record',
    version: 1,
    session: 's-1',
    daemonID: 'd-1',
    target: 'box',
    revision: 3,
    updatedAt: '2026-10-08T09:30:00.000Z',
    name: 'login fix',
    transcriptPath: '/home/dev/.claude/projects/app/4d2c.jsonl',
    scope: {
      workspace: { path: '/src/app', branch: 'main', repoURL: null, sha: null },
      worktrees: [],
      branches: [],
      pullRequests: [],
    },
  };

  // the reader's schema as the format stood before it gained the two fields
  const nullableString = z.string().nullable();
  const worktree = z.object({ path: z.string(), branch: nullableString });
  const branch = z.object({ name: z.string(), repo: z.string() });

  const pullRequest = z.object({
    repo: z.string(),
    number: z.number(),
    url: z.string(),
    branch: z.string(),
  });

  const workspace = z.object({
    path: z.string(),
    branch: nullableString,
    repoURL: nullableString,
    sha: nullableString,
  });

  const scope = z.object({
    workspace,
    worktrees: z.array(worktree),
    branches: z.array(branch),
    pullRequests: z.array(pullRequest),
  });

  const olderReader = z.object({
    format: z.literal('atc.session-record'),
    version: z.literal(1),
    session: z.string(),
    daemonID: z.string(),
    target: z.string(),
    revision: z.number().int().positive(),
    updatedAt: z.string(),
    scope,
  });

  const text = JSON.stringify(record);
  const parsed = olderReader.safeParse(JSON.parse(text));

  expect(parsed.data).toStrictEqual({
    format: 'atc.session-record',
    version: 1,
    session: 's-1',
    daemonID: 'd-1',
    target: 'box',
    revision: 3,
    updatedAt: '2026-10-08T09:30:00.000Z',
    scope: {
      workspace: { path: '/src/app', branch: 'main', repoURL: null, sha: null },
      worktrees: [],
      branches: [],
      pullRequests: [],
    },
  });
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
