import { expect, test } from 'bun:test';
import { parsePort } from './parse-port';

test.each([
  ['0', 0],
  ['1', 1],
  ['8414', 8414],
  ['65535', 65_535],
])('it parses %p as a port', (raw, port) => {
  expect(parsePort(raw)).toStrictEqual({ ok: true, port });
});

test.each(['', '65536', 'abc', '1.5', '-1', '0x50', '1e3', ' 80', '080000'])(
  'it refuses %p as a port',
  (raw) => {
    expect(parsePort(raw)).toStrictEqual({
      ok: false,
      message: `--port takes a port from 0 to 65535, not '${raw}'`,
    });
  },
);
