import { expect, test } from 'bun:test';
import { parsePTYProtocols } from './parse-pty-protocols';

test('it reads the token from the bearer subprotocol beside the live-terminal one', () => {
  expect(parsePTYProtocols('atc.pty.v1, atc.bearer.dG9rZW4rLz0')).toStrictEqual({
    ok: true,
    token: 'token+/=',
  });
});

test.each([
  ['no header', null],
  ['a header without the live-terminal protocol', 'atc.bearer.dG9rZW4'],
])('it refuses %s as no protocol', (_label, header) => {
  expect(parsePTYProtocols(header)).toStrictEqual({ ok: false, reason: 'no_protocol' });
});

test.each([
  ['no bearer subprotocol', 'atc.pty.v1'],
  ['an empty bearer subprotocol', 'atc.pty.v1, atc.bearer.'],
  ['two bearer subprotocols', 'atc.pty.v1, atc.bearer.YQ, atc.bearer.Yg'],
])('it refuses %s as no token', (_label, header) => {
  expect(parsePTYProtocols(header)).toStrictEqual({ ok: false, reason: 'no_token' });
});
