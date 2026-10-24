import { expect, test } from 'bun:test';
import { buildPinnedRequest } from './build-pinned-request';

test('it sends to the checked IPv4 address with the callback host for Host and SNI', () => {
  const signal = new AbortController().signal;

  const pinned = buildPinnedRequest(
    {
      url: 'https://hooks.example.com:8443/mcp-events/hook-7f3a?route=main',
      headers: { 'webhook-id': 'msg_one' },
      body: '{"name":"session.turn_done"}',
    },
    '93.184.215.14',
    signal,
  );

  expect(pinned).toStrictEqual({
    target: 'https://93.184.215.14:8443/mcp-events/hook-7f3a?route=main',
    init: {
      method: 'POST',
      headers: {
        'webhook-id': 'msg_one',
        host: 'hooks.example.com:8443',
        'content-type': 'application/json',
      },
      body: '{"name":"session.turn_done"}',
      redirect: 'manual',
      signal,
      tls: { serverName: 'hooks.example.com', checkServerIdentity: expect.any(Function) },
    },
  });
});

test('it brackets a checked IPv6 address in the target', () => {
  const pinned = buildPinnedRequest(
    { url: 'https://hooks.example.com/hook', headers: {}, body: '{}' },
    '2606:4700:10::6814:179a',
    new AbortController().signal,
  );

  expect(pinned.target).toBe('https://[2606:4700:10::6814:179a]/hook');
});

test('it sends no SNI name when the callback host is an address', () => {
  const pinned = buildPinnedRequest(
    { url: 'https://93.184.215.14/hook', headers: {}, body: '{}' },
    '93.184.215.14',
    new AbortController().signal,
  );

  expect(pinned.init.tls).toStrictEqual({ checkServerIdentity: expect.any(Function) });
});
