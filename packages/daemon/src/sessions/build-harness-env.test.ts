import { expect, test } from 'bun:test';
import { buildHarnessEnv } from './build-harness-env';

test('it appends the session attribute to the resource attributes the daemon holds', () => {
  const env = buildHarnessEnv(
    { TMPDIR: '/scratch' },
    { sessionID: 's-1' },
    { daemonEnv: { OTEL_RESOURCE_ATTRIBUTES: 'service.namespace=lab' }, withheldEnv: [] },
  );

  expect(env).toStrictEqual({
    TMPDIR: '/scratch',
    ATC_SESSION_ID: 's-1',
    OTEL_RESOURCE_ATTRIBUTES: 'service.namespace=lab,atc.session.id=s-1',
  });
});

test("it appends the session attribute to the plan's resource attributes over the daemon's", () => {
  const env = buildHarnessEnv(
    { OTEL_RESOURCE_ATTRIBUTES: 'team=tools' },
    { sessionID: 's-1' },
    { daemonEnv: { OTEL_RESOURCE_ATTRIBUTES: 'service.namespace=lab' }, withheldEnv: [] },
  );

  expect(env['OTEL_RESOURCE_ATTRIBUTES']).toBe('team=tools,atc.session.id=s-1');
});

test('it tags a session that withholds the daemon resource attributes with its session alone', () => {
  const env = buildHarnessEnv(
    {},
    { sessionID: 's-1' },
    {
      daemonEnv: { OTEL_RESOURCE_ATTRIBUTES: 'service.namespace=lab' },
      withheldEnv: ['OTEL_RESOURCE_ATTRIBUTES'],
    },
  );

  expect(env['OTEL_RESOURCE_ATTRIBUTES']).toBe('atc.session.id=s-1');
});

test('it copies no other daemon variable into the harness environment', () => {
  const env = buildHarnessEnv(
    {},
    { sessionID: 's-1' },
    { daemonEnv: { DAEMON_ONLY: 'x' }, withheldEnv: [] },
  );

  expect(env).toStrictEqual({
    ATC_SESSION_ID: 's-1',
    OTEL_RESOURCE_ATTRIBUTES: 'atc.session.id=s-1',
  });
});
