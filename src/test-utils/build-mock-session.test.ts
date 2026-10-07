import { expect, test } from 'bun:test';
import { toSessionID } from '../shared/to-session-id';
import { buildMockSession } from './build-mock-session';

test('it builds a default session record', () => {
  const session = buildMockSession();

  expect(session).toStrictEqual({
    id: expect.toBeString(),
    name: expect.toBeString(),
    cwd: expect.toStartWith('/'),
    kind: 'pty',
    pty: null,
    state: 'exited',
    unread: false,
    lastMsg: '',
    agent: 'claude',
    pinned: false,
    lastAttachedAt: expect.toBeNumber(),
    repoRoot: session.cwd,
    namedBy: 'auto',
    createdAt: expect.toBeNumber(),
    parent: null,
    target: 'local',
    targetIdentity: 'local-pty:test',
    withheldEnv: [],
    desired: 'run',
    vm: 'none',
    attachment: 'local',
    suspended: false,
    hostKey: session.id,
    bridgeEpoch: 0,
  });
});

test('it keys the default host by an overridden id', () => {
  const session = buildMockSession({ id: toSessionID('s-1') });

  expect(session).toStrictEqual({
    id: toSessionID('s-1'),
    name: expect.toBeString(),
    cwd: expect.toStartWith('/'),
    kind: 'pty',
    pty: null,
    state: 'exited',
    unread: false,
    lastMsg: '',
    agent: 'claude',
    pinned: false,
    lastAttachedAt: expect.toBeNumber(),
    repoRoot: session.cwd,
    namedBy: 'auto',
    createdAt: expect.toBeNumber(),
    parent: null,
    target: 'local',
    targetIdentity: 'local-pty:test',
    withheldEnv: [],
    desired: 'run',
    vm: 'none',
    attachment: 'local',
    suspended: false,
    hostKey: toSessionID('s-1'),
    bridgeEpoch: 0,
  });
});

test('it applies overrides on top of the defaults', () => {
  const session = buildMockSession({ state: 'running', parent: toSessionID('s-parent') });

  expect(session).toStrictEqual({
    id: expect.toBeString(),
    name: expect.toBeString(),
    cwd: expect.toStartWith('/'),
    kind: 'pty',
    pty: null,
    state: 'running',
    unread: false,
    lastMsg: '',
    agent: 'claude',
    pinned: false,
    lastAttachedAt: expect.toBeNumber(),
    repoRoot: session.cwd,
    namedBy: 'auto',
    createdAt: expect.toBeNumber(),
    parent: toSessionID('s-parent'),
    target: 'local',
    targetIdentity: 'local-pty:test',
    withheldEnv: [],
    desired: 'run',
    vm: 'none',
    attachment: 'local',
    suspended: false,
    hostKey: session.id,
    bridgeEpoch: 0,
  });
});
