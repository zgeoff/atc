import { expect, test } from 'bun:test';
import { pickTabTarget } from './pick-tab-target';

test('it prefers the most urgent needs-you session over any done session', () => {
  const target = pickTabTarget(
    [
      {
        id: 'a',
        state: 'done',
        pinned: false,
        lastAttachedAt: 1,
        createdAt: 1,
        alive: true,
        kind: 'pty',
      },
      {
        id: 'b',
        state: 'needs_you',
        pinned: false,
        lastAttachedAt: 2,
        createdAt: 2,
        alive: true,
        kind: 'pty',
      },
    ],
    (id) => new Map([['a', 500]]).get(id),
  );

  expect(target?.id).toBe('b');
});

test('it falls back to the terminal session whose turn finished most recently', () => {
  const target = pickTabTarget(
    [
      {
        id: 'a',
        state: 'done',
        pinned: false,
        lastAttachedAt: 1,
        createdAt: 1,
        alive: true,
        kind: 'pty',
      },
      {
        id: 'b',
        state: 'done',
        pinned: false,
        lastAttachedAt: 2,
        createdAt: 2,
        alive: true,
        kind: 'pty',
      },
      {
        id: 'c',
        state: 'running',
        pinned: false,
        lastAttachedAt: 3,
        createdAt: 3,
        alive: true,
        kind: 'pty',
      },
    ],
    (id) =>
      new Map([
        ['a', 100],
        ['b', 200],
      ]).get(id),
  );

  expect(target?.id).toBe('b');
});

test('it ranks done sessions without a recorded finish time last', () => {
  const target = pickTabTarget(
    [
      {
        id: 'a',
        state: 'done',
        pinned: false,
        lastAttachedAt: 1,
        createdAt: 1,
        alive: true,
        kind: 'pty',
      },
      {
        id: 'b',
        state: 'done',
        pinned: false,
        lastAttachedAt: 2,
        createdAt: 2,
        alive: true,
        kind: 'pty',
      },
    ],
    (id) => new Map([['b', 200]]).get(id),
  );

  expect(target?.id).toBe('b');
});

test('it skips headless and dead sessions in the done fallback', () => {
  const target = pickTabTarget(
    [
      {
        id: 'a',
        state: 'done',
        pinned: false,
        lastAttachedAt: 1,
        createdAt: 1,
        alive: true,
        kind: 'jsonl',
      },
      {
        id: 'b',
        state: 'done',
        pinned: false,
        lastAttachedAt: 2,
        createdAt: 2,
        alive: false,
        kind: 'pty',
      },
      {
        id: 'c',
        state: 'done',
        pinned: false,
        lastAttachedAt: 3,
        createdAt: 3,
        alive: true,
        kind: 'pty',
      },
    ],
    (id) =>
      new Map([
        ['a', 300],
        ['b', 200],
        ['c', 100],
      ]).get(id),
  );

  expect(target?.id).toBe('c');
});

test('it picks nothing when no session needs you and none are done', () => {
  const target = pickTabTarget(
    [
      {
        id: 'a',
        state: 'running',
        pinned: false,
        lastAttachedAt: 1,
        createdAt: 1,
        alive: true,
        kind: 'pty',
      },
    ],
    (id) => new Map<string, number>().get(id),
  );

  expect(target).toBeUndefined();
});
