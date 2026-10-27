import { expect, mock, test } from 'bun:test';
import { toSessionID } from '@atcx/contract';
import type { DaemonContext, OutputClient } from '../daemon-context';
import type { SessionWatch } from '../sessions/create-session-output';
import { buildStubDaemonContext } from '../testing/build-stub-daemon-context';
import { buildScopedContext } from './build-scoped-context';
import { buildTargetAccessFromGrants } from './build-target-access-from-grants';
import { CONTEXT_MEMBER_SCOPES } from './context-member-scopes';

test("it gives a principal the daemon's own member for every member it does not narrow", () => {
  const ctx = buildStubDaemonContext();
  const scoped = buildScopedContext(ctx, buildTargetAccessFromGrants([]), 'principal-a');

  const shared = Object.entries(CONTEXT_MEMBER_SCOPES)
    .filter(([, scope]) => scope !== 'narrowed')
    .map(([member]) => member);

  expect(shared).toSatisfyAll(
    (member: string) => Reflect.get(scoped, member) === Reflect.get(ctx, member),
  );
});

test('it gives a principal a member of its own for every member it narrows', () => {
  const ctx = buildStubDaemonContext();
  const scoped = buildScopedContext(ctx, buildTargetAccessFromGrants([]), 'principal-a');

  const narrowed = Object.entries(CONTEXT_MEMBER_SCOPES)
    .filter(([, scope]) => scope === 'narrowed')
    .map(([member]) => member);

  expect(narrowed).toSatisfyAll(
    (member: string) => Reflect.get(scoped, member) !== Reflect.get(ctx, member),
  );
});

test('it leaves out a member the daemon leaves unset', () => {
  const { queueBytes: _, ...ctx } = buildStubDaemonContext();
  const scoped = buildScopedContext(ctx, buildTargetAccessFromGrants([]), 'principal-a');

  expect(scoped).not.toContainKey('queueBytes');
});

test('it reads no menu of a session outside the access', () => {
  const ctx = buildStubDaemonContext({ canSeeSession: () => false });
  const scoped = buildScopedContext(ctx, buildTargetAccessFromGrants([]), 'principal-a');

  expect(scoped.readSessionMenu(toSessionID('s-hidden'))).resolves.toBe('missing');
});

test('it watches a session inside the access', () => {
  const ctx = buildStubDaemonContext({
    watchSession: () => Promise.resolve({ cols: 80, rows: 24, seq: 3, replay: 'build passed' }),
  });

  const scoped = buildScopedContext(ctx, buildTargetAccessFromGrants([]), 'principal-a');

  expect(
    scoped.watchSession({ sendOutput: mock<OutputClient['sendOutput']>() }, toSessionID('s-1')),
  ).resolves.toStrictEqual({ cols: 80, rows: 24, seq: 3, replay: 'build passed' });
});

test('it watches no session outside the access, without reaching the daemon watch', () => {
  const watchSession = mock<DaemonContext['watchSession']>();
  const ctx = buildStubDaemonContext({ canSeeSession: () => false, watchSession });
  const scoped = buildScopedContext(ctx, buildTargetAccessFromGrants([]), 'principal-a');

  const watched = scoped.watchSession(
    { sendOutput: mock<OutputClient['sendOutput']>() },
    toSessionID('s-hidden'),
  );

  expect(watched).resolves.toBe('missing');
  expect(watchSession).not.toHaveBeenCalled();
});

test('it refuses a watch whose session leaves the access while its replay is captured, and ends the watch', () => {
  const reply = Promise.withResolvers<SessionWatch>();
  const canSeeSession = mock<DaemonContext['canSeeSession']>(() => true);
  const detachSession = mock<DaemonContext['detachSession']>();

  const ctx = buildStubDaemonContext({
    canSeeSession,
    watchSession: () => reply.promise,
    detachSession,
  });

  const scoped = buildScopedContext(ctx, buildTargetAccessFromGrants([]), 'principal-a');
  const client = { sendOutput: mock<OutputClient['sendOutput']>() };
  const watched = scoped.watchSession(client, toSessionID('s-parent'));

  canSeeSession.mockReturnValue(false);
  reply.resolve({ cols: 80, rows: 24, seq: 3, replay: 'sub-session output' });

  expect(watched).resolves.toBe('missing');
  expect(detachSession).toHaveBeenCalledExactlyOnceWith(client, toSessionID('s-parent'));
});

test('it applies no menu choice in a session outside the access', () => {
  const ctx = buildStubDaemonContext({ canSeeSession: () => false });
  const scoped = buildScopedContext(ctx, buildTargetAccessFromGrants([]), 'principal-a');

  expect(
    scoped.applySessionMenuChoice(toSessionID('s-hidden'), { menuToken: 'm-1', key: 'escape' }),
  ).resolves.toBe('missing');
});
