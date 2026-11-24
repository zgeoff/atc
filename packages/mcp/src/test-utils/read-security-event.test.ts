import { expect, test } from 'bun:test';
import { readSecurityEvent } from './read-security-event';

test('it reads the event a security line carries', () => {
  expect(readSecurityEvent('atc security {"kind":"bad_host","route":"/rpc"}')).toStrictEqual({
    kind: 'bad_host',
    route: '/rpc',
  });
});

test('it refuses a security line that carries no object', () => {
  expect(() => readSecurityEvent('atc security 5')).toThrow('not a JSON object');
});
