import { expect, test } from 'bun:test';
import { buildMockMirrorSession } from './build-mock-mirror-session';

test('it builds a default mirror session', () => {
  const session = buildMockMirrorSession();

  expect(session).toStrictEqual({
    id: expect.toBeString(),
    name: expect.toBeString(),
    cwd: expect.toStartWith('/'),
    pinned: false,
    lastAttachedAt: expect.toBeNumber(),
    repoRoot: session.cwd,
    state: 'running',
    unread: false,
    lastMsg: expect.toBeString(),
    createdAt: expect.toBeNumber(),
    kind: 'pty',
    alive: true,
    resumable: false,
    canEject: false,
    agent: 'claude',
    parent: null,
    target: 'local',
    model: null,
    harness: 'running',
  });
});

test('it applies overrides on top of the defaults', () => {
  expect(
    buildMockMirrorSession({
      id: 'worker',
      parent: 'wrangler',
      agent: 'grok',
      model: 'opus',
      harness: 'suspended',
    }),
  ).toStrictEqual({
    id: 'worker',
    name: expect.toBeString(),
    cwd: expect.toStartWith('/'),
    pinned: false,
    lastAttachedAt: expect.toBeNumber(),
    repoRoot: expect.toStartWith('/'),
    state: 'running',
    unread: false,
    lastMsg: expect.toBeString(),
    createdAt: expect.toBeNumber(),
    kind: 'pty',
    alive: true,
    resumable: false,
    canEject: false,
    agent: 'grok',
    parent: 'wrangler',
    target: 'local',
    model: 'opus',
    harness: 'suspended',
  });
});
