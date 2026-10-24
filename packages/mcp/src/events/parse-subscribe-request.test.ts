import { expect, test } from 'bun:test';
import { parseSubscribeRequest } from './parse-subscribe-request';

test('it parses a webhook subscription to a known event type', () => {
  const secret = `whsec_${Buffer.alloc(32, 5).toString('base64')}`;

  const parsed = parseSubscribeRequest({
    name: 'session.needs_input',
    arguments: {},
    delivery: { mode: 'webhook', url: 'https://hooks.example.com/hook', secret },
    cursor: 'cursor-1',
    ttlMs: 3_600_000,
  });

  expect(parsed).toStrictEqual({
    ok: true,
    request: {
      type: expect.objectContaining({ name: 'session.needs_input', kind: 'needs-input' }),
      url: 'https://hooks.example.com/hook',
      secret,
      secretBytes: Buffer.alloc(32, 5),
      cursor: 'cursor-1',
      ttlMs: 3_600_000,
    },
  });
});

test('it reads an absent cursor as none', () => {
  const parsed = parseSubscribeRequest({
    name: 'session.turn_done',
    delivery: {
      mode: 'webhook',
      url: 'https://hooks.example.com/hook',
      secret: `whsec_${Buffer.alloc(32, 5).toString('base64')}`,
    },
  });

  expect(parsed.ok && parsed.request.cursor).toBeNull();
});

test('it refuses an unknown event name as not found', () => {
  const parsed = parseSubscribeRequest({
    name: 'session.exploded',
    delivery: {
      mode: 'webhook',
      url: 'https://hooks.example.com/hook',
      secret: `whsec_${Buffer.alloc(32, 5).toString('base64')}`,
    },
  });

  expect(parsed).toStrictEqual({
    ok: false,
    refusal: {
      code: -32_023,
      message: "no event type is named 'session.exploded'",
      data: { kind: 'event' },
    },
  });
});

test('it refuses arguments, which no event type takes', () => {
  const parsed = parseSubscribeRequest({
    name: 'session.turn_done',
    arguments: { session: 's-1' },
    delivery: {
      mode: 'webhook',
      url: 'https://hooks.example.com/hook',
      secret: `whsec_${Buffer.alloc(32, 5).toString('base64')}`,
    },
  });

  expect(parsed).toStrictEqual({
    ok: false,
    refusal: { code: -32_602, message: 'session.turn_done takes no arguments' },
  });
});

test('it refuses a delivery mode other than webhook as unsupported', () => {
  const parsed = parseSubscribeRequest({
    name: 'session.turn_done',
    delivery: {
      mode: 'push',
      url: 'https://hooks.example.com/hook',
      secret: `whsec_${Buffer.alloc(32, 5).toString('base64')}`,
    },
  });

  expect(parsed).toStrictEqual({
    ok: false,
    refusal: {
      code: -32_026,
      message: 'session.turn_done delivers by webhook only',
      data: { feature: 'deliveryMode', value: 'push' },
    },
  });
});

test.each([
  ['a plain http URL', 'http://hooks.example.com/hook'],
  ['a URL with credentials', 'https://user:pass@hooks.example.com/hook'],
  ['text that is not a URL', 'hooks.example.com/hook'],
])('it refuses %s as the callback', (_label, url) => {
  const parsed = parseSubscribeRequest({
    name: 'session.turn_done',
    delivery: { mode: 'webhook', url, secret: `whsec_${Buffer.alloc(32, 5).toString('base64')}` },
  });

  expect(parsed).toStrictEqual({
    ok: false,
    refusal: { code: -32_602, message: 'delivery.url must be an https URL with no credentials' },
  });
});

test('it refuses a secret that is not a whsec_ value', () => {
  const parsed = parseSubscribeRequest({
    name: 'session.turn_done',
    delivery: { mode: 'webhook', url: 'https://hooks.example.com/hook', secret: 'hunter2' },
  });

  expect(parsed).toStrictEqual({
    ok: false,
    refusal: {
      code: -32_602,
      message: 'delivery.secret must be whsec_ followed by the base64 of 24 to 64 bytes',
    },
  });
});
