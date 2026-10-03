import { expect, test } from 'bun:test';
import { DaemonError } from '../protocol/daemon-error';
import { buildGatewayError } from './build-gateway-error';

test('it rewrites the effectRef of an uncertain spawn and the id its message quotes', () => {
  const error = buildGatewayError(
    new DaemonError(
      'outcome_unknown',
      "the session.spawn under idempotency key 'k' was interrupted; check 2b7f0c1e before retrying",
      { effectRef: '2b7f0c1e' },
    ),
    { name: 'cloud', incarnation: '0f6c2a8e' },
    new Map(),
  );

  expect({ code: error.code, message: error.message, data: error.data }).toStrictEqual({
    code: 'outcome_unknown',
    message:
      "the session.spawn under idempotency key 'k' was interrupted; check cloud.0f6c2a8e.2b7f0c1e before retrying",
    data: { effectRef: 'cloud.0f6c2a8e.2b7f0c1e' },
  });
});

test('it replaces the daemon id a refusal quotes from the request with the id the caller sent', () => {
  const error = buildGatewayError(
    new DaemonError('no_such_session', "no session 's1'"),
    { name: 'cloud', incarnation: '0f6c2a8e' },
    new Map([['s1', 'cloud.0f6c2a8e.s1']]),
  );

  expect({ code: error.code, message: error.message, data: error.data }).toStrictEqual({
    code: 'no_such_session',
    message: "no session 'cloud.0f6c2a8e.s1'",
    data: undefined,
  });
});

test('it rewrites the session, message, and parent of error data and keeps other fields', () => {
  const error = buildGatewayError(
    new DaemonError('target_forbidden', 'nope', {
      session: 's1',
      message: 'm-1',
      parent: 's0',
      target: 'box',
    }),
    { name: 'cloud', incarnation: '0f6c2a8e' },
    new Map(),
  );

  expect(error.data).toStrictEqual({
    session: 'cloud.0f6c2a8e.s1',
    message: 'cloud.0f6c2a8e.m-1',
    parent: 'cloud.0f6c2a8e.s0',
    target: 'box',
  });
});
