import { expect, test } from 'bun:test';
import type { EventMsg } from '../protocol/protocol';
import { parseDaemonEvent } from './parse-daemon-event';

test('it parses a SessionAdded event into a mirror session', () => {
  const raw: EventMsg = {
    v: 3,
    ev: 'SessionAdded',
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
    ev: 'SessionAdded',
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
      parent: null,
    },
  });
});

test('it parses a SessionState event into a mirror session', () => {
  const raw: EventMsg = {
    v: 3,
    ev: 'SessionState',
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

  if (event === null || event.ev !== 'SessionState') {
    throw new Error('expected a SessionState event');
  }

  expect(event.session.state).toBe('needs_you');
});

test('it parses a SessionRenamed event', () => {
  const raw: EventMsg = {
    v: 3,
    ev: 'SessionRenamed',
    s: 's-1',
    name: 'auth-bug',
    namedBy: 'agent',
  };

  const event = parseDaemonEvent(raw);

  expect(event).toStrictEqual({
    ev: 'SessionRenamed',
    s: 's-1',
    name: 'auth-bug',
    namedBy: 'agent',
  });
});

test('it parses a SessionRemoved event', () => {
  const raw: EventMsg = { v: 3, ev: 'SessionRemoved', s: 's-1' };
  const event = parseDaemonEvent(raw);

  expect(event).toStrictEqual({ ev: 'SessionRemoved', s: 's-1' });
});

test('it parses a SessionResized event', () => {
  const raw: EventMsg = { v: 3, ev: 'SessionResized', s: 's-1', cols: 80, rows: 24 };
  const event = parseDaemonEvent(raw);

  expect(event).toStrictEqual({ ev: 'SessionResized', s: 's-1', cols: 80, rows: 24 });
});

test('it parses a SessionOutput event', () => {
  const raw: EventMsg = { v: 3, ev: 'SessionOutput', s: 's-1', seq: 41, d: '[1mhello[0m' };
  const event = parseDaemonEvent(raw);

  expect(event).toStrictEqual({
    ev: 'SessionOutput',
    s: 's-1',
    seq: 41,
    d: '[1mhello[0m',
  });
});

test('it parses a SessionDesync event', () => {
  const raw: EventMsg = { v: 3, ev: 'SessionDesync', s: 's-1', dropped: 512 };
  const event = parseDaemonEvent(raw);

  expect(event).toStrictEqual({ ev: 'SessionDesync', s: 's-1', dropped: 512 });
});

test('it parses a PermissionRequested event', () => {
  const raw: EventMsg = {
    v: 3,
    ev: 'PermissionRequested',
    request: 'r-1',
    s: 's-1',
    message: 'allow file write?',
    respondable: true,
  };

  const event = parseDaemonEvent(raw);

  expect(event).toStrictEqual({
    ev: 'PermissionRequested',
    request: 'r-1',
    s: 's-1',
    message: 'allow file write?',
    respondable: true,
  });
});

test('it parses a PermissionResolved event', () => {
  const raw: EventMsg = { v: 3, ev: 'PermissionResolved', request: 'r-1', decision: 'allow' };
  const event = parseDaemonEvent(raw);

  expect(event).toStrictEqual({ ev: 'PermissionResolved', request: 'r-1', decision: 'allow' });
});

test('it still parses a known event that carries extra fields', () => {
  const raw: EventMsg = {
    v: 3,
    ev: 'SessionRemoved',
    s: 's-1',
    reason: 'killed',
    unexpected: { nested: true },
  };

  const event = parseDaemonEvent(raw);

  expect(event).toStrictEqual({ ev: 'SessionRemoved', s: 's-1' });
});

test('it misses on an unknown event kind instead of throwing', () => {
  const raw: EventMsg = { v: 3, ev: 'session.teleported', s: 's-1' };
  let event: unknown = 'not called';

  expect(() => {
    event = parseDaemonEvent(raw);
  }).not.toThrow();

  expect(event).toBeNull();
});

test('it misses on a known event kind with a missing required field', () => {
  const raw: EventMsg = { v: 3, ev: 'SessionRenamed', s: 's-1', namedBy: 'agent' };
  const event = parseDaemonEvent(raw);

  expect(event).toBeNull();
});

test('it misses on a SessionAdded event whose session descriptor is malformed', () => {
  const raw: EventMsg = {
    v: 3,
    ev: 'SessionAdded',
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
