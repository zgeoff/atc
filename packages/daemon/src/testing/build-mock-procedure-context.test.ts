import { expect, test } from 'bun:test';
import { toSessionID } from '@atcx/contract';
import { buildConnectionRequests } from '../transport/build-connection-requests';
import { buildMockProcedureContext } from './build-mock-procedure-context';
import { buildStubDaemonContext } from './build-stub-daemon-context';

test('it builds a context for the daemon owner that gives no principal', () => {
  const context = buildMockProcedureContext();

  expect(context.ctx.build).toBe('atc/test');
  expect(context.as).toBeNull();
});

test('it builds handlers that act as no principal and no caller session', () => {
  expect(buildMockProcedureContext().requests.identity).toStrictEqual({
    principal: null,
    callerSession: null,
    peerSession: null,
    helloClient: 'atc/test',
  });
});

test('it keeps the daemon context the overrides give', () => {
  const ctx = buildStubDaemonContext();

  expect(buildMockProcedureContext({ ctx }).ctx).toBe(ctx);
});

test('it keeps the handlers the overrides give', () => {
  const ctx = buildStubDaemonContext();

  const requests = buildConnectionRequests({
    client: { sendOutput: () => {}, sendEvent: () => {} },
    ctx,
    identity: {
      principal: null,
      callerSession: toSessionID('s-caller'),
      peerSession: null,
      helloClient: 'atc/test',
    },
  });

  expect(buildMockProcedureContext({ ctx, requests }).requests).toBe(requests);
});

test('it refuses a handshake', () => {
  expect(
    buildMockProcedureContext().answerHello({ client: 'atc/test' }),
  ).rejects.toThrowWithMessage(Error, 'the mock procedure context has no handshake');
});

test('it refuses an event subscription', () => {
  expect(() => buildMockProcedureContext().subscribeEvents(new AbortController().signal)).toThrow(
    'the mock procedure context has no event feed',
  );
});
