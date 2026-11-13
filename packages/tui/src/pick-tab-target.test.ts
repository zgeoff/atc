import { expect, test } from 'bun:test';
import { pickTabTarget } from './pick-tab-target';

test('it prefers the most urgent needs-you session over any done session', () => {
  const sessions = [
    {
      daemon: null,
      id: 'a',
      parent: null,
      state: 'done',
      pinned: false,
      lastAttachedAt: 1,
      createdAt: 1,
      alive: true,
      kind: 'pty',
    },
    {
      daemon: null,
      id: 'b',
      parent: null,
      state: 'needs_you',
      pinned: false,
      lastAttachedAt: 2,
      createdAt: 2,
      alive: true,
      kind: 'pty',
    },
  ] as const;

  const target = pickTabTarget(sessions, (key) => new Map([['a', 500]]).get(key.id));

  expect(target).toBe(sessions[1]);
});

test('it falls back to the terminal session whose turn finished most recently', () => {
  const sessions = [
    {
      daemon: null,
      id: 'a',
      parent: null,
      state: 'done',
      pinned: false,
      lastAttachedAt: 1,
      createdAt: 1,
      alive: true,
      kind: 'pty',
    },
    {
      daemon: null,
      id: 'b',
      parent: null,
      state: 'done',
      pinned: false,
      lastAttachedAt: 2,
      createdAt: 2,
      alive: true,
      kind: 'pty',
    },
    {
      daemon: null,
      id: 'c',
      parent: null,
      state: 'running',
      pinned: false,
      lastAttachedAt: 3,
      createdAt: 3,
      alive: true,
      kind: 'pty',
    },
  ] as const;

  const target = pickTabTarget(sessions, (key) =>
    new Map([
      ['a', 100],
      ['b', 200],
    ]).get(key.id),
  );

  expect(target).toBe(sessions[1]);
});

test('it ranks done sessions without a recorded finish time last', () => {
  const sessions = [
    {
      daemon: null,
      id: 'a',
      parent: null,
      state: 'done',
      pinned: false,
      lastAttachedAt: 1,
      createdAt: 1,
      alive: true,
      kind: 'pty',
    },
    {
      daemon: null,
      id: 'b',
      parent: null,
      state: 'done',
      pinned: false,
      lastAttachedAt: 2,
      createdAt: 2,
      alive: true,
      kind: 'pty',
    },
  ] as const;

  const target = pickTabTarget(sessions, (key) => new Map([['b', 200]]).get(key.id));

  expect(target).toBe(sessions[1]);
});

test('it skips headless and dead sessions in the done fallback', () => {
  const sessions = [
    {
      daemon: null,
      id: 'a',
      parent: null,
      state: 'done',
      pinned: false,
      lastAttachedAt: 1,
      createdAt: 1,
      alive: true,
      kind: 'headless',
    },
    {
      daemon: null,
      id: 'b',
      parent: null,
      state: 'done',
      pinned: false,
      lastAttachedAt: 2,
      createdAt: 2,
      alive: false,
      kind: 'pty',
    },
    {
      daemon: null,
      id: 'c',
      parent: null,
      state: 'done',
      pinned: false,
      lastAttachedAt: 3,
      createdAt: 3,
      alive: true,
      kind: 'pty',
    },
  ] as const;

  const target = pickTabTarget(sessions, (key) =>
    new Map([
      ['a', 300],
      ['b', 200],
      ['c', 100],
    ]).get(key.id),
  );

  expect(target).toBe(sessions[2]);
});

test('it picks nothing when no session needs you and none are done', () => {
  const sessions = [
    {
      daemon: null,
      id: 'a',
      parent: null,
      state: 'running',
      pinned: false,
      lastAttachedAt: 1,
      createdAt: 1,
      alive: true,
      kind: 'pty',
    },
  ] as const;

  const target = pickTabTarget(sessions, (key) => new Map<string, number>().get(key.id));

  expect(target).toBeUndefined();
});
