import { expect, mock, test } from 'bun:test';
import { buildMockPublishedRecord } from '@atc/test-utils';
import { toSessionID } from '@atcx/contract';
import { call } from '@orpc/server';
import type { DaemonContext } from '../daemon-context';
import { buildMockProcedureContext } from '../testing/build-mock-procedure-context';
import { buildStubDaemonContext } from '../testing/build-stub-daemon-context';
import { buildConnectionRequests } from './build-connection-requests';
import { DAEMON_ROUTER } from './daemon-router';

test('#session.ack answers with what the procedure returns', async () => {
  const ctx = buildStubDaemonContext({ ackSession: () => true });

  const answer = await call(
    DAEMON_ROUTER.session.ack,
    { session: 's-1' },
    { context: buildMockProcedureContext({ ctx }) },
  );

  expect(answer).toStrictEqual({});
});

test('#session.forget leaves out an answer field the procedure does not declare', async () => {
  const forgotten = { forgotten: true as const, destroyed: false, host: 'h-1' };
  const ctx = buildStubDaemonContext({ forgetSession: () => Promise.resolve(forgotten) });

  const answer = await call(
    DAEMON_ROUTER.session.forget,
    { session: 's-1' },
    { context: buildMockProcedureContext({ ctx }) },
  );

  expect(answer).toStrictEqual({ forgotten: true, destroyed: false });
});

test('#session.ack passes on the refusal the procedure throws', () => {
  const ctx = buildStubDaemonContext({ ackSession: () => false });

  expect(
    call(
      DAEMON_ROUTER.session.ack,
      { session: 's-2' },
      { context: buildMockProcedureContext({ ctx }) },
    ),
  ).rejects.toMatchObject({ code: 'no_such_session', message: "no session 's-2'" });
});

test('#session.watch answers with the size, the sequence and the replay of the session', async () => {
  const watch = { cols: 100, rows: 30, seq: 7, replay: 'ready' };
  const ctx = buildStubDaemonContext({ watchSession: () => Promise.resolve(watch) });

  const answer = await call(
    DAEMON_ROUTER.session.watch,
    { session: 's-1' },
    { context: buildMockProcedureContext({ ctx }) },
  );

  expect(answer).toStrictEqual({ cols: 100, rows: 30, seq: 7, replay: 'ready' });
});

test.each([
  ['missing', 'no_such_session', "no session 's-3'"],
  ['dead', 'session_dead', "session 's-3' has no live process"],
] as const)('#session.watch refuses a %s session as %s', (result, code, message) => {
  const ctx = buildStubDaemonContext({ watchSession: () => Promise.resolve(result) });

  expect(
    call(
      DAEMON_ROUTER.session.watch,
      { session: 's-3' },
      { context: buildMockProcedureContext({ ctx }) },
    ),
  ).rejects.toMatchObject({ code, message });
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
    Object.fromEntries([['__proto__', { worktrees: [] }]]),
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
])('#session.scope.add refuses %s as scope_invalid', (_label, scope, message) => {
  expect(
    call(
      DAEMON_ROUTER.session.scope.add,
      { session: 's-6', scope },
      { context: buildMockProcedureContext() },
    ),
  ).rejects.toMatchObject({ code: 'scope_invalid', message: expect.toInclude(message) });
});

test.each([
  ['the session itself', 's-6', 's-6'],
  ['a child of the session', 's-6', 's-child'],
  ['a grandchild of the session', 's-6', 's-grandchild'],
])('#session.scope.add refuses %s, which sits inside its tree', (_label, session, caller) => {
  const isCallerTree = mock<DaemonContext['isCallerTree']>(() => true);
  const ctx = buildStubDaemonContext({ isCallerTree });

  const requests = buildConnectionRequests({
    client: { sendOutput: () => {}, sendEvent: () => {} },
    ctx,
    identity: {
      principal: null,
      callerSession: toSessionID(caller),
      peerSession: null,
      helloClient: 'atc/test',
    },
  });

  const added = call(
    DAEMON_ROUTER.session.scope.add,
    { session, scope: { worktrees: [{ path: '/srv/site' }] } },
    { context: buildMockProcedureContext({ ctx, requests }) },
  );

  expect(added).rejects.toMatchObject({
    code: 'unauthorized',
    message: `session '${caller}' cannot add to the scope of session '${session}': a session never widens its own scope or that of a session above it`,
  });

  expect(isCallerTree).toHaveBeenCalledExactlyOnceWith(toSessionID(session), toSessionID(caller));
});

test('#session.scope.add adds to the scope of a session from a caller outside its tree', async () => {
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

  const answer = await call(
    DAEMON_ROUTER.session.scope.add,
    { session: 's-6', scope: { worktrees: [{ path: '/srv/site' }] } },
    { context: buildMockProcedureContext({ ctx, requests }) },
  );

  expect(answer).toStrictEqual({ record });

  expect(updated).toHaveBeenCalledExactlyOnceWith(toSessionID('s-6'), {
    worktrees: [{ path: '/srv/site' }],
    branches: [],
    pullRequests: [],
  });
});

test('#session.message keys a send by its payload alone, leaving out the sender name', async () => {
  const written = mock<DaemonContext['writeSessionMessage']>(() =>
    Promise.resolve({ message: 'm-7', status: 'queued' }),
  );

  const ctx = buildStubDaemonContext({
    writeSessionMessage: written,
    isSessionVisible: () => true,
  });

  const context = buildMockProcedureContext({ ctx });

  await call(
    DAEMON_ROUTER.session.message,
    { session: 's-7', text: 'hello', idempotencyKey: 'k-7', from: 'bot' },
    { context },
  );

  await call(
    DAEMON_ROUTER.session.message,
    { session: 's-7', text: 'hello', idempotencyKey: 'k-7' },
    { context },
  );

  expect(written.mock.calls[0]?.[0].keyed).toMatchObject({ key: 'k-7' });
  expect(written.mock.calls[0]?.[0].keyed).toStrictEqual(written.mock.calls[1]?.[0].keyed);
});
