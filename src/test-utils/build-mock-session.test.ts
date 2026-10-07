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

  expect({ id: session.id, hostKey: session.hostKey }).toStrictEqual({
    id: toSessionID('s-1'),
    hostKey: toSessionID('s-1'),
  });
});

test('it replaces the fields an override gives', () => {
  const session = buildMockSession({ state: 'running', parent: toSessionID('s-parent') });

  expect({ state: session.state, parent: session.parent }).toStrictEqual({
    state: 'running',
    parent: toSessionID('s-parent'),
  });
});
