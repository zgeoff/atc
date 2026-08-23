import { expect, test } from 'bun:test';
import type { EventMsg } from '../protocol/protocol';
import { parseDaemonEvent } from './parse-daemon-event';

test('it parses a session.added event into a mirror session', () => {
  const raw: EventMsg = {
    v: 2,
    ev: 'session.added',
    session: {
      id: 's-1',
      name: 'work',
      cwd: '/repo',
      state: 'running',
      unread: false,
      lastMsg: 'hi',
      createdAt: 1000,
      alive: true,
    },
  };

  const event = parseDaemonEvent(raw);

  expect(event).toStrictEqual({
    ev: 'session.added',
    session: {
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
    },
  });
});

test('it parses a session.state event into a mirror session', () => {
  const raw: EventMsg = {
    v: 2,
    ev: 'session.state',
    session: {
      id: 's-1',
      name: 'work',
      cwd: '/repo',
      state: 'needs_you',
      unread: false,
      lastMsg: 'hi',
      createdAt: 1000,
      alive: true,
    },
  };

  const event = parseDaemonEvent(raw);

  if (event === null || event.ev !== 'session.state') {
    throw new Error('expected a session.state event');
  }

  expect(event.session.state).toBe('needs_you');
});

test('it parses a session.renamed event', () => {
  const raw: EventMsg = {
    v: 2,
    ev: 'session.renamed',
    s: 's-1',
    name: 'auth-bug',
    namedBy: 'agent',
  };

  const event = parseDaemonEvent(raw);

  expect(event).toStrictEqual({
    ev: 'session.renamed',
    s: 's-1',
    name: 'auth-bug',
    namedBy: 'agent',
  });
});

test('it parses a session.removed event', () => {
  const raw: EventMsg = { v: 2, ev: 'session.removed', s: 's-1' };
  const event = parseDaemonEvent(raw);

  expect(event).toStrictEqual({ ev: 'session.removed', s: 's-1' });
});

test('it parses a session.resized event', () => {
  const raw: EventMsg = { v: 2, ev: 'session.resized', s: 's-1', cols: 80, rows: 24 };
  const event = parseDaemonEvent(raw);

  expect(event).toStrictEqual({ ev: 'session.resized', s: 's-1', cols: 80, rows: 24 });
});

test('it parses a session.output event', () => {
  const raw: EventMsg = { v: 2, ev: 'session.output', s: 's-1', seq: 41, d: '[1mhello[0m' };
  const event = parseDaemonEvent(raw);

  expect(event).toStrictEqual({
    ev: 'session.output',
    s: 's-1',
    seq: 41,
    d: '[1mhello[0m',
  });
});

test('it parses a session.desync event', () => {
  const raw: EventMsg = { v: 2, ev: 'session.desync', s: 's-1', dropped: 512 };
  const event = parseDaemonEvent(raw);

  expect(event).toStrictEqual({ ev: 'session.desync', s: 's-1', dropped: 512 });
});

test('it parses a permission.requested event', () => {
  const raw: EventMsg = {
    v: 2,
    ev: 'permission.requested',
    request: 'r-1',
    s: 's-1',
    message: 'allow file write?',
    respondable: true,
  };

  const event = parseDaemonEvent(raw);

  expect(event).toStrictEqual({
    ev: 'permission.requested',
    request: 'r-1',
    s: 's-1',
    message: 'allow file write?',
    respondable: true,
  });
});

test('it parses a permission.resolved event', () => {
  const raw: EventMsg = { v: 2, ev: 'permission.resolved', request: 'r-1', decision: 'allow' };
  const event = parseDaemonEvent(raw);

  expect(event).toStrictEqual({ ev: 'permission.resolved', request: 'r-1', decision: 'allow' });
});

test('it still parses a known event that carries extra fields', () => {
  const raw: EventMsg = {
    v: 2,
    ev: 'session.removed',
    s: 's-1',
    reason: 'killed',
    unexpected: { nested: true },
  };

  const event = parseDaemonEvent(raw);

  expect(event).toStrictEqual({ ev: 'session.removed', s: 's-1' });
});

test('it misses on an unknown event kind instead of throwing', () => {
  const raw: EventMsg = { v: 2, ev: 'session.teleported', s: 's-1' };
  let event: unknown = 'not called';

  expect(() => {
    event = parseDaemonEvent(raw);
  }).not.toThrow();

  expect(event).toBeNull();
});

test('it misses on a known event kind with a missing required field', () => {
  const raw: EventMsg = { v: 2, ev: 'session.renamed', s: 's-1', namedBy: 'agent' };
  const event = parseDaemonEvent(raw);

  expect(event).toBeNull();
});

test('it misses on a session.added event whose session descriptor is malformed', () => {
  const raw: EventMsg = {
    v: 2,
    ev: 'session.added',
    session: {
      id: 's-1',
      cwd: '/repo',
      state: 'running',
      unread: false,
      lastMsg: 'hi',
      createdAt: 1000,
      alive: true,
    },
  };

  const event = parseDaemonEvent(raw);

  expect(event).toBeNull();
});
