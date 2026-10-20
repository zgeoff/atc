import { expect, test } from 'bun:test';
import { formatSecurityEvent } from './format-security-event';

test('it formats an event with every field as one prefixed JSON line', () => {
  const line = formatSecurityEvent(
    {
      kind: 'owner_auth',
      outcome: 'failed',
      reason: 'assertion_failed',
      path: '/login',
      requester: {
        socketAddress: '10.0.0.7',
        connectingIP: { address: '203.0.113.9', provenance: 'unverified' },
        userAgent: 'Mozilla/5.0',
      },
      client: { id: 'client-1', name: 'Claude' },
      redirectHost: 'claude.ai',
      correlationID: '6f1c2a4e-0000-4000-8000-000000000000',
    },
    Date.UTC(2026, 9, 14, 12, 0, 0),
  );

  expect(line).toMatchInlineSnapshot(
    `"atc security {"version":1,"ts":"2026-10-14T12:00:00.000Z","kind":"owner_auth","outcome":"failed","reason":"assertion_failed","method":"passkey","route":"/login","client":{"id":"client-1","name":"Claude"},"redirectHost":"claude.ai","correlationID":"6f1c2a4e-0000-4000-8000-000000000000","peer":{"address":"10.0.0.7","provenance":"socket"},"forwarded":{"address":"203.0.113.9","header":"cf-connecting-ip","provenance":"unverified"},"userAgent":{"summary":"Mozilla/5.0","provenance":"client"}}"`,
  );
});

test('it labels a forwarded address from a listed proxy as trusted', () => {
  const line = formatSecurityEvent(
    {
      kind: 'consent',
      outcome: 'allowed',
      path: '/consent',
      requester: {
        socketAddress: '10.0.0.7',
        connectingIP: { address: '203.0.113.9', provenance: 'trusted' },
        userAgent: null,
      },
    },
    0,
  );

  expect(JSON.parse(line.slice('atc security '.length))).toMatchObject({
    forwarded: { address: '203.0.113.9', header: 'cf-connecting-ip', provenance: 'trusted' },
  });
});

test('it formats an event with no optional field and no request headers', () => {
  const line = formatSecurityEvent(
    {
      kind: 'consent',
      outcome: 'denied',
      path: '/consent',
      requester: { socketAddress: null, connectingIP: null, userAgent: null },
    },
    Date.UTC(2026, 9, 14, 12, 0, 0),
  );

  expect(JSON.parse(line.slice('atc security '.length))).toStrictEqual({
    version: 1,
    ts: '2026-10-14T12:00:00.000Z',
    kind: 'consent',
    outcome: 'denied',
    route: '/consent',
  });
});

test('it formats a suppressed event with the dropped kind and count', () => {
  expect(
    formatSecurityEvent(
      { kind: 'suppressed', reason: 'authorize_invalid', count: 7 },
      Date.UTC(2026, 9, 14, 12, 0, 0),
    ),
  ).toBe(
    'atc security {"version":1,"ts":"2026-10-14T12:00:00.000Z","kind":"suppressed","reason":"authorize_invalid","count":7}',
  );
});

test('it writes a path outside the fixed routes as other', () => {
  const line = formatSecurityEvent(
    {
      kind: 'authorize_invalid',
      outcome: 'rejected',
      reason: 'bad_host',
      path: '/oauth2/authorize/../../etc/passwd?code=secret',
      requester: { socketAddress: null, connectingIP: null, userAgent: null },
    },
    0,
  );

  expect(JSON.parse(line.slice('atc security '.length))).toMatchObject({ route: 'other' });
});

test('it drops control and format characters from client strings and cuts their length', () => {
  const line = formatSecurityEvent(
    {
      kind: 'authorize_started',
      outcome: 'accepted',
      path: '/oauth2/authorize',
      requester: {
        socketAddress: `\u001B[31m${'1'.repeat(60)}`,
        connectingIP: { address: '203.0.113.9\nforged', provenance: 'unverified' },
        userAgent: `ua‮${'x'.repeat(100)}`,
      },
      client: { id: `id\u0007${'i'.repeat(100)}`, name: `name‍${'n'.repeat(150)}` },
      redirectHost: `host\r${'h'.repeat(300)}`,
    },
    0,
  );

  expect(JSON.parse(line.slice('atc security '.length))).toMatchObject({
    client: { id: `id${'i'.repeat(62)}`, name: `name${'n'.repeat(96)}` },
    redirectHost: `host ${'h'.repeat(250)}`,
    peer: { address: `[31m${'1'.repeat(41)}` },
    forwarded: { address: '203.0.113.9 forged' },
    userAgent: { summary: `ua${'x'.repeat(58)}` },
  });
});

test('it holds no field outside the contract when the event carries one', () => {
  const event = {
    kind: 'authorize_started' as const,
    outcome: 'accepted' as const,
    path: '/oauth2/authorize',
    requester: { socketAddress: null, connectingIP: null, userAgent: null },
    oauthQuery: 'code=canary-code&state=canary-state',
  };

  const line = formatSecurityEvent(event, 0);

  expect(line).not.toInclude('canary');
});

test('it writes the line on one line whatever the client strings hold', () => {
  const separators = String.fromCodePoint(0x20_28, 0x20_29);

  const line = formatSecurityEvent(
    {
      kind: 'authorize_started',
      outcome: 'accepted',
      path: '/oauth2/authorize',
      requester: {
        socketAddress: null,
        connectingIP: null,
        userAgent: `a\nb\r\nc${separators}d`,
      },
    },
    0,
  );

  expect(line).not.toMatch(new RegExp(`[\n\r${separators}]`, 'u'));
});

test('it marks a passkey enrollment with the enrollment token method', () => {
  const line = formatSecurityEvent(
    {
      kind: 'owner_auth',
      outcome: 'failed',
      reason: 'invalid_token',
      path: '/enroll',
      requester: { socketAddress: null, connectingIP: null, userAgent: null },
    },
    Date.UTC(2026, 9, 14, 12, 0, 0),
  );

  expect(line).toBe(
    'atc security {"version":1,"ts":"2026-10-14T12:00:00.000Z","kind":"owner_auth","outcome":"failed","reason":"invalid_token","method":"enrollment_token","route":"/enroll"}',
  );
});
