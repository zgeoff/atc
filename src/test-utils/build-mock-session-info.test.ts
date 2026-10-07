import { expect, test } from 'bun:test';
import { toSessionID } from '../shared/to-session-id';
import { buildMockSessionInfo } from './build-mock-session-info';

test('it builds a default session info', () => {
  expect(buildMockSessionInfo()).toStrictEqual({
    id: expect.toBeString(),
    name: expect.toBeString(),
    cwd: expect.toStartWith('/'),
    state: 'running',
    unread: false,
    lastMsg: expect.toBeString(),
    agent: 'claude',
    pinned: false,
    lastAttachedAt: expect.toBeNumber(),
    repoRoot: expect.toStartWith('/'),
    namedBy: 'user',
    createdAt: expect.toBeNumber(),
    kind: 'pty',
    alive: true,
    canEject: false,
    locator: { daemonID: expect.toBeString(), targetID: 'local' },
    lifecycle: { desired: 'run', vm: 'none', harness: 'running', attachment: 'local' },
  });
});

test('it applies overrides on top of the defaults', () => {
  expect(
    buildMockSessionInfo({
      name: 'alpha',
      state: 'needs_you',
      parent: toSessionID('s-parent'),
      locator: { targetID: 'box' },
      lifecycle: { vm: 'asleep', harness: 'suspended' },
    }),
  ).toStrictEqual({
    id: expect.toBeString(),
    name: 'alpha',
    cwd: expect.toStartWith('/'),
    state: 'needs_you',
    unread: false,
    lastMsg: expect.toBeString(),
    agent: 'claude',
    pinned: false,
    lastAttachedAt: expect.toBeNumber(),
    repoRoot: expect.toStartWith('/'),
    namedBy: 'user',
    createdAt: expect.toBeNumber(),
    kind: 'pty',
    alive: true,
    canEject: false,
    locator: { daemonID: expect.toBeString(), targetID: 'box' },
    lifecycle: { desired: 'run', vm: 'asleep', harness: 'suspended', attachment: 'local' },
    parent: toSessionID('s-parent'),
  });
});
