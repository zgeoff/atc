import { expect, test } from 'bun:test';
import { buildBindRefusal } from './build-bind-refusal';

test('it holds the address and the code of the bind error', () => {
  const error = Object.assign(new Error('address in use'), { code: 'EADDRINUSE' });
  const refusal = buildBindRefusal({ host: '127.0.0.1', port: 7420 }, error);

  expect(refusal).toMatchObject({
    message: 'atc daemon: --listen cannot bind 127.0.0.1:7420 (EADDRINUSE)',
    code: 'listen_refused',
  });
});

test('it brackets an IPv6 address', () => {
  const error = Object.assign(new Error('address in use'), { code: 'EADDRINUSE' });
  const refusal = buildBindRefusal({ host: '::1', port: 7420 }, error);

  expect(refusal.message).toBe('atc daemon: --listen cannot bind [::1]:7420 (EADDRINUSE)');
});

test('it holds the text of a bind error with no code', () => {
  const refusal = buildBindRefusal({ host: '127.0.0.1', port: 7420 }, 'socket closed');

  expect(refusal.message).toBe('atc daemon: --listen cannot bind 127.0.0.1:7420 (socket closed)');
});
