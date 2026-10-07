import { expect, test } from 'bun:test';
import { toMirrorSession } from './to-mirror-session';

test('it round-trips a gateway agent id instead of coercing it to claude', () => {
  const mirror = toMirrorSession({
    id: 's-1',
    name: 'work',
    cwd: '/repo',
    state: 'running',
    unread: false,
    lastMsg: 'hi',
    createdAt: 1000,
    alive: true,
    agent: 'zai',
  });

  expect(mirror).toStrictEqual({
    id: 's-1',
    name: 'work',
    cwd: '/repo',
    pinned: false,
    lastAttachedAt: 1000,
    repoRoot: '/repo',
    state: 'running',
    unread: false,
    lastMsg: 'hi',
    createdAt: 1000,
    kind: 'pty',
    alive: true,
    resumable: false,
    canEject: false,
    agent: 'zai',
    parent: null,
    target: 'local',
    model: null,
    harness: 'running',
  });
});

test('it falls back the last attach time to the creation time when the descriptor omits it', () => {
  const mirror = toMirrorSession({
    id: 's-1',
    name: 'work',
    cwd: '/repo',
    state: 'running',
    unread: false,
    lastMsg: 'hi',
    createdAt: 4200,
    alive: true,
  });

  expect(mirror).toStrictEqual({
    id: 's-1',
    name: 'work',
    cwd: '/repo',
    pinned: false,
    lastAttachedAt: 4200,
    repoRoot: '/repo',
    state: 'running',
    unread: false,
    lastMsg: 'hi',
    createdAt: 4200,
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

test('it falls back the repository root to the working directory when the descriptor omits it', () => {
  const mirror = toMirrorSession({
    id: 's-1',
    name: 'work',
    cwd: '/repo/nested',
    state: 'running',
    unread: false,
    lastMsg: 'hi',
    createdAt: 1000,
    alive: true,
  });

  expect(mirror).toStrictEqual({
    id: 's-1',
    name: 'work',
    cwd: '/repo/nested',
    pinned: false,
    lastAttachedAt: 1000,
    repoRoot: '/repo/nested',
    state: 'running',
    unread: false,
    lastMsg: 'hi',
    createdAt: 1000,
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

test('it reads a session as a terminal session when the descriptor omits its kind', () => {
  const mirror = toMirrorSession({
    id: 's-1',
    name: 'work',
    cwd: '/repo',
    state: 'running',
    unread: false,
    lastMsg: 'hi',
    createdAt: 1000,
    alive: true,
  });

  expect(mirror).toStrictEqual({
    id: 's-1',
    name: 'work',
    cwd: '/repo',
    pinned: false,
    lastAttachedAt: 1000,
    repoRoot: '/repo',
    state: 'running',
    unread: false,
    lastMsg: 'hi',
    createdAt: 1000,
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

test('it keeps the parent when the descriptor carries one', () => {
  const mirror = toMirrorSession({
    id: 's-1',
    name: 'work',
    cwd: '/repo',
    state: 'running',
    unread: false,
    lastMsg: 'hi',
    createdAt: 1000,
    alive: true,
    parent: 's-0',
  });

  expect(mirror).toStrictEqual({
    id: 's-1',
    name: 'work',
    cwd: '/repo',
    pinned: false,
    lastAttachedAt: 1000,
    repoRoot: '/repo',
    state: 'running',
    unread: false,
    lastMsg: 'hi',
    createdAt: 1000,
    kind: 'pty',
    alive: true,
    resumable: false,
    canEject: false,
    agent: 'claude',
    parent: 's-0',
    target: 'local',
    model: null,
    harness: 'running',
  });
});

test('it reports no parent when the descriptor omits it', () => {
  const mirror = toMirrorSession({
    id: 's-1',
    name: 'work',
    cwd: '/repo',
    state: 'running',
    unread: false,
    lastMsg: 'hi',
    createdAt: 1000,
    alive: true,
  });

  expect(mirror).toStrictEqual({
    id: 's-1',
    name: 'work',
    cwd: '/repo',
    pinned: false,
    lastAttachedAt: 1000,
    repoRoot: '/repo',
    state: 'running',
    unread: false,
    lastMsg: 'hi',
    createdAt: 1000,
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

// A gateway session runs a Claude binary under another agent id, so the
// descriptor's own flag, not the agent id, decides whether its row offers
// the headless handoff.
test('it offers the headless handoff when the descriptor allows it', () => {
  const mirror = toMirrorSession({
    id: 's-1',
    name: 'work',
    cwd: '/repo',
    state: 'running',
    unread: false,
    lastMsg: 'hi',
    createdAt: 1000,
    alive: true,
    agent: 'zai',
    canEject: true,
  });

  expect(mirror).toStrictEqual({
    id: 's-1',
    name: 'work',
    cwd: '/repo',
    pinned: false,
    lastAttachedAt: 1000,
    repoRoot: '/repo',
    state: 'running',
    unread: false,
    lastMsg: 'hi',
    createdAt: 1000,
    kind: 'pty',
    alive: true,
    resumable: false,
    canEject: true,
    agent: 'zai',
    parent: null,
    target: 'local',
    model: null,
    harness: 'running',
  });
});

test('it withholds the headless handoff when the descriptor omits it', () => {
  const mirror = toMirrorSession({
    id: 's-1',
    name: 'work',
    cwd: '/repo',
    state: 'running',
    unread: false,
    lastMsg: 'hi',
    createdAt: 1000,
    alive: true,
  });

  expect(mirror).toStrictEqual({
    id: 's-1',
    name: 'work',
    cwd: '/repo',
    pinned: false,
    lastAttachedAt: 1000,
    repoRoot: '/repo',
    state: 'running',
    unread: false,
    lastMsg: 'hi',
    createdAt: 1000,
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

test('it reads the target from the descriptor locator', () => {
  const mirror = toMirrorSession({
    id: 's-1',
    name: 'work',
    cwd: '/repo',
    state: 'running',
    unread: false,
    lastMsg: 'hi',
    createdAt: 1000,
    alive: true,
    locator: { daemonID: 'd-1', targetID: 'imp-box' },
  });

  expect(mirror).toStrictEqual({
    id: 's-1',
    name: 'work',
    cwd: '/repo',
    pinned: false,
    lastAttachedAt: 1000,
    repoRoot: '/repo',
    state: 'running',
    unread: false,
    lastMsg: 'hi',
    createdAt: 1000,
    kind: 'pty',
    alive: true,
    resumable: false,
    canEject: false,
    agent: 'claude',
    parent: null,
    target: 'imp-box',
    model: null,
    harness: 'running',
  });
});

test('it falls back the target to local when the descriptor carries no locator', () => {
  const mirror = toMirrorSession({
    id: 's-1',
    name: 'work',
    cwd: '/repo',
    state: 'running',
    unread: false,
    lastMsg: 'hi',
    createdAt: 1000,
    alive: true,
  });

  expect(mirror).toStrictEqual({
    id: 's-1',
    name: 'work',
    cwd: '/repo',
    pinned: false,
    lastAttachedAt: 1000,
    repoRoot: '/repo',
    state: 'running',
    unread: false,
    lastMsg: 'hi',
    createdAt: 1000,
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

test('it keeps the model the session was spawned with', () => {
  const mirror = toMirrorSession({
    id: 's-1',
    name: 'work',
    cwd: '/repo',
    state: 'running',
    unread: false,
    lastMsg: 'hi',
    createdAt: 1000,
    alive: true,
    model: 'opus',
  });

  expect(mirror).toStrictEqual({
    id: 's-1',
    name: 'work',
    cwd: '/repo',
    pinned: false,
    lastAttachedAt: 1000,
    repoRoot: '/repo',
    state: 'running',
    unread: false,
    lastMsg: 'hi',
    createdAt: 1000,
    kind: 'pty',
    alive: true,
    resumable: false,
    canEject: false,
    agent: 'claude',
    parent: null,
    target: 'local',
    model: 'opus',
    harness: 'running',
  });
});

test('it reports no model when the descriptor omits it', () => {
  const mirror = toMirrorSession({
    id: 's-1',
    name: 'work',
    cwd: '/repo',
    state: 'running',
    unread: false,
    lastMsg: 'hi',
    createdAt: 1000,
    alive: true,
  });

  expect(mirror).toStrictEqual({
    id: 's-1',
    name: 'work',
    cwd: '/repo',
    pinned: false,
    lastAttachedAt: 1000,
    repoRoot: '/repo',
    state: 'running',
    unread: false,
    lastMsg: 'hi',
    createdAt: 1000,
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

test('it reads the harness layer of the descriptor lifecycle', () => {
  const mirror = toMirrorSession({
    id: 's-1',
    name: 'work',
    cwd: '/repo',
    state: 'running',
    unread: false,
    lastMsg: 'hi',
    createdAt: 1000,
    alive: false,
    lifecycle: { desired: 'sleep', vm: 'asleep', harness: 'suspended', attachment: 'detached' },
  });

  expect(mirror).toStrictEqual({
    id: 's-1',
    name: 'work',
    cwd: '/repo',
    pinned: false,
    lastAttachedAt: 1000,
    repoRoot: '/repo',
    state: 'running',
    unread: false,
    lastMsg: 'hi',
    createdAt: 1000,
    kind: 'pty',
    alive: false,
    resumable: false,
    canEject: false,
    agent: 'claude',
    parent: null,
    target: 'local',
    model: null,
    harness: 'suspended',
  });
});

test('it reads an exited harness from a dead session when the descriptor omits the lifecycle', () => {
  const mirror = toMirrorSession({
    id: 's-1',
    name: 'work',
    cwd: '/repo',
    state: 'running',
    unread: false,
    lastMsg: 'hi',
    createdAt: 1000,
    alive: false,
  });

  expect(mirror).toStrictEqual({
    id: 's-1',
    name: 'work',
    cwd: '/repo',
    pinned: false,
    lastAttachedAt: 1000,
    repoRoot: '/repo',
    state: 'running',
    unread: false,
    lastMsg: 'hi',
    createdAt: 1000,
    kind: 'pty',
    alive: false,
    resumable: false,
    canEject: false,
    agent: 'claude',
    parent: null,
    target: 'local',
    model: null,
    harness: 'exited',
  });
});

test('it reads a running harness from a live session when the descriptor omits the lifecycle', () => {
  const mirror = toMirrorSession({
    id: 's-1',
    name: 'work',
    cwd: '/repo',
    state: 'running',
    unread: false,
    lastMsg: 'hi',
    createdAt: 1000,
    alive: true,
  });

  expect(mirror).toStrictEqual({
    id: 's-1',
    name: 'work',
    cwd: '/repo',
    pinned: false,
    lastAttachedAt: 1000,
    repoRoot: '/repo',
    state: 'running',
    unread: false,
    lastMsg: 'hi',
    createdAt: 1000,
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

test('it returns null for a descriptor missing a required field, rather than throwing', () => {
  expect(
    toMirrorSession({
      id: 's-1',
      cwd: '/repo',
      state: 'running',
      unread: false,
      lastMsg: 'hi',
      createdAt: 1000,
      alive: true,
    }),
  ).toBeNull();
});
