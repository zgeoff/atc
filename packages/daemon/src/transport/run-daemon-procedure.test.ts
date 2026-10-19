import { expect, mock, test } from 'bun:test';
import { toSessionID } from '@atc/core';
import { buildMockPublishedRecord } from '@atc/test-utils';
import type { DaemonContext } from '../daemon-context';
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

test.each([
  [
    'an unknown key',
    { colours: [] },
    'scope.colours is invalid: a scope holds only worktrees, branches, and pullRequests',
  ],
  ['a scope of the wrong type', 'everything', 'scope is invalid: scope must be an object'],
  ['a path of the wrong type', { worktrees: [{ path: 7 }] }, 'a path must be a string'],
  ['a relative path', { worktrees: [{ path: 'srv/site' }] }, 'a path must be absolute'],
  [
    'a branch name over 255 characters',
    { branches: [{ name: 'b'.repeat(256) }] },
    'a branch name must be at most 255 characters',
  ],
  [
    'a path holding a control character',
    { worktrees: [{ path: '/srv/si\u0007te' }] },
    'a path must not hold control characters',
  ],
  [
    'a prototype key',
    JSON.parse('{"__proto__":{"worktrees":[]}}') as unknown,
    'a scope holds only worktrees, branches, and pullRequests',
  ],
  [
    'a pull request missing its number',
    { pullRequests: [{ repo: 'acme/site' }] },
    'a pull request number must be a number',
  ],
  [
    'more than 64 worktrees',
    { worktrees: Array.from({ length: 65 }, (_, index) => ({ path: `/srv/site-${index}` })) },
    'worktrees holds at most 64 entries',
  ],
])('it refuses a scope add with %s as scope_invalid', (_label, scope, message) => {
  const ctx = buildStubDaemonContext();

  const requests = buildConnectionRequests({
    client: { sendOutput: () => {}, sendEvent: () => {} },
    ctx,
    identity: { principal: null, callerSession: null, peerSession: null, helloClient: 'atc/test' },
  });

  expect(
    runDaemonProcedure('session.scope.add', { session: 's-6', scope }, { ctx, requests, as: null }),
  ).rejects.toMatchObject({ code: 'scope_invalid', message: expect.toInclude(message) as unknown });
});

test('it refuses a scope add from a session inside the tree of the session it widens', () => {
  const ctx = buildStubDaemonContext({ isCallerTree: () => true });

  const requests = buildConnectionRequests({
    client: { sendOutput: () => {}, sendEvent: () => {} },
    ctx,
    identity: {
      principal: null,
      callerSession: toSessionID('s-child'),
      peerSession: null,
      helloClient: 'atc/test',
    },
  });

  expect(
    runDaemonProcedure(
      'session.scope.add',
      { session: 's-6', scope: { worktrees: [{ path: '/srv/site' }] } },
      { ctx, requests, as: null },
    ),
  ).rejects.toMatchObject({
    code: 'unauthorized',
    message:
      "session 's-child' cannot add to the scope of session 's-6': a session never widens its own scope or that of a session above it",
  });
});

test('it adds to the scope of a session from a caller outside its tree', async () => {
  const record = buildMockPublishedRecord({ session: 's-6' });
  const updated = mock<DaemonContext['updateSessionScope']>(() => Promise.resolve(record));
  const ctx = buildStubDaemonContext({ isCallerTree: () => false, updateSessionScope: updated });

  const requests = buildConnectionRequests({
    client: { sendOutput: () => {}, sendEvent: () => {} },
    ctx,
    identity: {
      principal: null,
      callerSession: toSessionID('s-other'),
      peerSession: null,
      helloClient: 'atc/test',
    },
  });

  const answer = await runDaemonProcedure(
    'session.scope.add',
    { session: 's-6', scope: { worktrees: [{ path: '/srv/site' }] } },
    { ctx, requests, as: null },
  );

  expect(answer).toStrictEqual({ record });

  expect(updated).toHaveBeenCalledExactlyOnceWith(toSessionID('s-6'), {
    worktrees: [{ path: '/srv/site' }],
    branches: [],
    pullRequests: [],
  });
});

test('it hashes the sender name a message sent untrimmed, as an older daemon stored it', async () => {
  const written = mock<DaemonContext['writeSessionMessage']>(() =>
    Promise.resolve({ message: 'm-7', status: 'queued' }),
  );

  const ctx = buildStubDaemonContext({
    writeSessionMessage: written,
    isSessionVisible: () => true,
  });

  const requests = buildConnectionRequests({
    client: { sendOutput: () => {}, sendEvent: () => {} },
    ctx,
    identity: { principal: null, callerSession: null, peerSession: null, helloClient: 'atc/test' },
  });

  await runDaemonProcedure(
    'session.message',
    { session: 's-7', text: 'hello', idempotencyKey: 'k-7', from: ' bot ' },
    { ctx, requests, as: null },
  );

  // The hash an older daemon stored for this request, over its raw `from`.
  expect(written.mock.calls[0]?.[3]?.legacyPayloadHashes).toContain(
    '6a460754da46224ce300921ea63b8d29a9c350eed7515e32d29596a1835ed628',
  );
});
