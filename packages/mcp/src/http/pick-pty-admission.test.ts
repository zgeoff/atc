import { expect, test } from 'bun:test';
import { pickPTYAdmission } from './pick-pty-admission';

test('it passes a request from a listed host and origin on to verify its token', () => {
  expect(
    pickPTYAdmission(
      {
        host: '127.0.0.1:8414',
        upgrade: 'websocket',
        origin: 'https://viewer.example.com',
        protocols: 'atc.pty.v1, atc.bearer.dmlld2VyLXRva2Vu',
        isServing: true,
      },
      {
        hosts: new Set(['127.0.0.1:8414', 'localhost:8414', 'atc.example.com']),
        allowedOrigins: new Set(['https://viewer.example.com']),
      },
    ),
  ).toStrictEqual({ kind: 'verify', token: 'viewer-token' });
});

test.each([
  ['no host', null],
  ['an empty host', ''],
  ['an unlisted host', 'evil.example'],
  ['a listed host without its port', '127.0.0.1'],
  ['a listed host on another port', '127.0.0.1:9999'],
  ['a listed host in capitals', 'LOCALHOST:8414'],
  ['a listed host with a suffix', '127.0.0.1:8414.evil.example'],
  ['a listed host with a trailing space', '127.0.0.1:8414 '],
  ['a listed host behind userinfo', 'atc.example.com@evil.example'],
])('it refuses %s with 403 before any other check', (_label, host) => {
  expect(
    pickPTYAdmission(
      {
        host,
        upgrade: null,
        origin: 'https://evil.example',
        protocols: null,
        isServing: false,
      },
      {
        hosts: new Set(['127.0.0.1:8414', 'localhost:8414', 'atc.example.com']),
        allowedOrigins: new Set(['https://viewer.example.com']),
      },
    ),
  ).toStrictEqual({
    kind: 'refuse',
    status: 403,
    outcome: { kind: 'authorize_invalid', reason: 'bad_host' },
  });
});

test('it answers 503 to a listed host while the server is not serving yet', () => {
  expect(
    pickPTYAdmission(
      { host: '127.0.0.1:8414', upgrade: null, origin: null, protocols: null, isServing: false },
      { hosts: new Set(['127.0.0.1:8414']), allowedOrigins: new Set() },
    ),
  ).toStrictEqual({ kind: 'refuse', status: 503, outcome: null });
});

test.each([
  ['no upgrade header', null],
  ['an upgrade to another protocol', 'h2c'],
])('it asks for a WebSocket upgrade from a request with %s', (_label, upgrade) => {
  expect(
    pickPTYAdmission(
      {
        host: '127.0.0.1:8414',
        upgrade,
        origin: 'https://evil.example',
        protocols: null,
        isServing: true,
      },
      { hosts: new Set(['127.0.0.1:8414']), allowedOrigins: new Set() },
    ),
  ).toStrictEqual({ kind: 'upgrade_required' });
});

test.each([
  ['an unlisted origin', 'https://evil.example'],
  ['a listed origin over http', 'http://viewer.example.com'],
  ['a listed origin with a trailing slash', 'https://viewer.example.com/'],
  ['the null origin of a sandboxed page', 'null'],
  ['an empty origin', ''],
])('it refuses %s with 403', (_label, origin) => {
  expect(
    pickPTYAdmission(
      {
        host: '127.0.0.1:8414',
        upgrade: 'websocket',
        origin,
        protocols: 'atc.pty.v1, atc.bearer.dmlld2VyLXRva2Vu',
        isServing: true,
      },
      {
        hosts: new Set(['127.0.0.1:8414']),
        allowedOrigins: new Set(['https://viewer.example.com']),
      },
    ),
  ).toStrictEqual({
    kind: 'refuse',
    status: 403,
    outcome: { kind: 'authorize_invalid', reason: 'bad_origin' },
  });
});

test('it refuses a request that offers no live-terminal subprotocol with 400', () => {
  expect(
    pickPTYAdmission(
      {
        host: '127.0.0.1:8414',
        upgrade: 'websocket',
        origin: null,
        protocols: 'atc.bearer.dmlld2VyLXRva2Vu',
        isServing: true,
      },
      { hosts: new Set(['127.0.0.1:8414']), allowedOrigins: new Set() },
    ),
  ).toStrictEqual({ kind: 'refuse', status: 400, outcome: null });
});

test('it refuses a request that offers no bearer token with 401', () => {
  expect(
    pickPTYAdmission(
      {
        host: '127.0.0.1:8414',
        upgrade: 'websocket',
        origin: null,
        protocols: 'atc.pty.v1',
        isServing: true,
      },
      { hosts: new Set(['127.0.0.1:8414']), allowedOrigins: new Set() },
    ),
  ).toStrictEqual({
    kind: 'refuse',
    status: 401,
    outcome: { kind: 'bearer', reason: 'malformed' },
  });
});
