import { expect, test } from 'bun:test';
import { buildStubDaemonContext } from '../testing/build-stub-daemon-context';
import { buildConnectionRequests } from './build-connection-requests';
import { runDaemonProcedure } from './run-daemon-procedure';

test('it answers a request with what its procedure returns', async () => {
  const ctx = buildStubDaemonContext({ ackSession: () => true });

  const requests = buildConnectionRequests({
    client: { sendOutput: () => {}, sendEvent: () => {} },
    ctx,
    identity: { principal: null, callerSession: null, peerSession: null, helloClient: 'atc/test' },
  });

  const answer = await runDaemonProcedure(
    'session.ack',
    { session: 's-1' },
    { ctx, requests, as: null },
  );

  expect(answer).toStrictEqual({});
});

test('it leaves out an answer field the procedure does not declare', async () => {
  const forgotten = { forgotten: true as const, destroyed: false, host: 'h-1' };
  const ctx = buildStubDaemonContext({ forgetSession: () => Promise.resolve(forgotten) });

  const requests = buildConnectionRequests({
    client: { sendOutput: () => {}, sendEvent: () => {} },
    ctx,
    identity: { principal: null, callerSession: null, peerSession: null, helloClient: 'atc/test' },
  });

  const answer = await runDaemonProcedure(
    'session.forget',
    { session: 's-1' },
    { ctx, requests, as: null },
  );

  expect(answer).toStrictEqual({ forgotten: true, destroyed: false });
});

test('it refuses a method no procedure answers', () => {
  const ctx = buildStubDaemonContext();

  const requests = buildConnectionRequests({
    client: { sendOutput: () => {}, sendEvent: () => {} },
    ctx,
    identity: { principal: null, callerSession: null, peerSession: null, helloClient: 'atc/test' },
  });

  expect(runDaemonProcedure('session.nope', {}, { ctx, requests, as: null })).rejects.toMatchObject(
    { code: 'unknown_method', message: "unknown method 'session.nope'" },
  );
});

test('it refuses params the schema refuses with the first issue as bad_args', () => {
  const ctx = buildStubDaemonContext();

  const requests = buildConnectionRequests({
    client: { sendOutput: () => {}, sendEvent: () => {} },
    ctx,
    identity: { principal: null, callerSession: null, peerSession: null, helloClient: 'atc/test' },
  });

  expect(
    runDaemonProcedure('daemon.backup', { path: 'relative.db' }, { ctx, requests, as: null }),
  ).rejects.toMatchObject({
    code: 'bad_args',
    message: 'daemon.backup path must be an absolute path',
  });
});

test('it passes on the refusal a procedure throws', () => {
  const ctx = buildStubDaemonContext({ ackSession: () => false });

  const requests = buildConnectionRequests({
    client: { sendOutput: () => {}, sendEvent: () => {} },
    ctx,
    identity: { principal: null, callerSession: null, peerSession: null, helloClient: 'atc/test' },
  });

  expect(
    runDaemonProcedure('session.ack', { session: 's-2' }, { ctx, requests, as: null }),
  ).rejects.toMatchObject({ code: 'no_such_session', message: "no session 's-2'" });
});

test('it refuses an answer the schema refuses as internal', () => {
  const ctx = buildStubDaemonContext({ writeStateBackup: () => Promise.resolve(Number.NaN) });

  const requests = buildConnectionRequests({
    client: { sendOutput: () => {}, sendEvent: () => {} },
    ctx,
    identity: { principal: null, callerSession: null, peerSession: null, helloClient: 'atc/test' },
  });

  expect(
    runDaemonProcedure('daemon.backup', { path: '/backup.db' }, { ctx, requests, as: null }),
  ).rejects.toMatchObject({
    code: 'internal',
    message: expect.toStartWith('Output validation failed: '),
  });
});
