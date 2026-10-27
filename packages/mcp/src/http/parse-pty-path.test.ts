import { expect, test } from 'bun:test';
import { parsePTYPath } from './parse-pty-path';

test('it finds the session id in a live-terminal path', () => {
  expect(parsePTYPath('/sessions/s-7f3a/pty')).toStrictEqual({
    kind: 'session',
    sessionID: 's-7f3a',
  });
});

test('it decodes an escaped session id', () => {
  expect(parsePTYPath('/sessions/s%2D7f3a/pty')).toStrictEqual({
    kind: 'session',
    sessionID: 's-7f3a',
  });
});

test.each(['/sessions/%/pty', '/sessions/s-%E0%A4%A/pty', '/sessions/%C0%AF/pty'])(
  'it reads the live-terminal path %s, whose escape decodes to nothing, as malformed',
  (path) => {
    expect(parsePTYPath(path)).toStrictEqual({ kind: 'malformed' });
  },
);

test.each(['/sessions/s-7f3a', '/sessions//pty', '/sessions/s-7f3a/pty/more', '/mcp'])(
  'it reads %s as another path',
  (path) => {
    expect(parsePTYPath(path)).toStrictEqual({ kind: 'other' });
  },
);
