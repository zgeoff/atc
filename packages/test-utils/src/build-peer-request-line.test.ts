import { expect, test } from 'bun:test';
import { buildPeerRequestLine } from './build-peer-request-line';

test('it encodes a call of a procedure as one peer request line', () => {
  expect(buildPeerRequestLine('1', '/daemon/hello', { client: 'atc/test' })).toBe(
    '{"i":"1","p":{"u":"/daemon/hello","b":{"json":{"client":"atc/test"}}}}\n',
  );
});

test('it encodes the headers a call carries', () => {
  expect(buildPeerRequestLine('4', '/session/list', {}, { 'x-atc-as': 'ci' })).toBe(
    '{"i":"4","p":{"u":"/session/list","b":{"json":{}},"h":{"x-atc-as":"ci"}}}\n',
  );
});
