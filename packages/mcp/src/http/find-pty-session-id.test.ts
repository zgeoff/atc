import { expect, test } from 'bun:test';
import { findPTYSessionID } from './find-pty-session-id';

test('it finds the session id in a live-terminal path', () => {
  expect(findPTYSessionID('/sessions/s-7f3a/pty')).toBe('s-7f3a');
});

test('it decodes an escaped session id', () => {
  expect(findPTYSessionID('/sessions/s%2D7f3a/pty')).toBe('s-7f3a');
});

test.each(['/sessions/s-7f3a', '/sessions//pty', '/sessions/s-7f3a/pty/more', '/mcp'])(
  'it finds no session in %s',
  (path) => {
    expect(findPTYSessionID(path)).toBeNull();
  },
);
