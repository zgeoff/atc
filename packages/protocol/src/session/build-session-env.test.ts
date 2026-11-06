import { expect, test } from 'bun:test';
import { buildSessionEnv } from './build-session-env';

test('it writes every set field under its variable', () => {
  expect(
    buildSessionEnv({
      sessionID: 's-1',
      socket: '/run/atc.sock',
      bridge: true,
      outbox: '/run/outbox',
      sessionRecord: '/run/record.json',
    }),
  ).toStrictEqual({
    ATC_SESSION_ID: 's-1',
    OTEL_RESOURCE_ATTRIBUTES: 'atc.session.id=s-1',
    ATC_SOCKET: '/run/atc.sock',
    ATC_BRIDGE: '1',
    ATC_OUTBOX: '/run/outbox',
    ATC_SESSION_RECORD: '/run/record.json',
    AUTO_MODE_SCOPE_FILE: '/run/record.scope.json',
  });
});

test('it leaves out a field that is not set and a bridge that is off', () => {
  expect(buildSessionEnv({ sessionID: 's-1', bridge: false })).toStrictEqual({
    ATC_SESSION_ID: 's-1',
    OTEL_RESOURCE_ATTRIBUTES: 'atc.session.id=s-1',
  });
});

test('it leaves the resource attributes alone when no session is set', () => {
  expect(
    buildSessionEnv({
      socket: '/run/atc.sock',
      inheritedEnv: { OTEL_RESOURCE_ATTRIBUTES: 'service.namespace=lab' },
    }),
  ).toStrictEqual({ ATC_SOCKET: '/run/atc.sock' });
});

test.each([
  ['one attribute', 'service.namespace=lab', 'service.namespace=lab,atc.session.id=s-1'],
  [
    'two attributes',
    'service.namespace=lab,deployment.environment=dev',
    'service.namespace=lab,deployment.environment=dev,atc.session.id=s-1',
  ],
  ['an empty value', '', 'atc.session.id=s-1'],
  [
    "a parent session's attribute",
    'atc.session.id=s-parent,service.namespace=lab',
    'service.namespace=lab,atc.session.id=s-1',
  ],
])(
  'it appends the session attribute to an inherited value with %s',
  (_case, inherited, expected) => {
    expect(
      buildSessionEnv({
        sessionID: 's-1',
        inheritedEnv: { OTEL_RESOURCE_ATTRIBUTES: inherited },
      }),
    ).toStrictEqual({ ATC_SESSION_ID: 's-1', OTEL_RESOURCE_ATTRIBUTES: expected });
  },
);

test('it percent-encodes a session ID that holds a separator', () => {
  expect(buildSessionEnv({ sessionID: 's,1=x' })['OTEL_RESOURCE_ATTRIBUTES']).toBe(
    'atc.session.id=s%2C1%3Dx',
  );
});
