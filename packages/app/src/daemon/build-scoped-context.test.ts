import { expect, test } from 'bun:test';
import { toSessionID } from '@atc/core';
import { buildStubDaemonContext } from '../test-utils/build-stub-daemon-context';
import { buildScopedContext } from './build-scoped-context';
import { CONTEXT_MEMBER_SCOPES } from './context-member-scopes';
import type { DaemonContext } from './daemon-context';
import { TargetAccess } from './target-access';

test("it gives a principal the daemon's own member for every member it does not narrow", () => {
  const ctx = buildStubDaemonContext();
  const scoped = buildScopedContext(ctx, new TargetAccess([]), 'principal-a');

  const shared = Object.entries(CONTEXT_MEMBER_SCOPES)
    .filter(([, scope]) => scope !== 'narrowed')
    .map(([member]) => member as keyof DaemonContext);

  expect(shared).toSatisfyAll((member: keyof DaemonContext) => scoped[member] === ctx[member]);
});

test('it gives a principal a member of its own for every member it narrows', () => {
  const ctx = buildStubDaemonContext();
  const scoped = buildScopedContext(ctx, new TargetAccess([]), 'principal-a');

  const narrowed = Object.entries(CONTEXT_MEMBER_SCOPES)
    .filter(([, scope]) => scope === 'narrowed')
    .map(([member]) => member as keyof DaemonContext);

  expect(narrowed).toSatisfyAll((member: keyof DaemonContext) => scoped[member] !== ctx[member]);
});

test('it leaves out a member the daemon leaves unset', () => {
  const { queueBytes: _, ...ctx } = buildStubDaemonContext();
  const scoped = buildScopedContext(ctx, new TargetAccess([]), 'principal-a');

  expect(scoped).not.toContainKey('queueBytes');
});

test('it reads no menu of a session outside the access', () => {
  const ctx = buildStubDaemonContext({ canSeeSession: () => false });
  const scoped = buildScopedContext(ctx, new TargetAccess([]), 'principal-a');

  expect(scoped.readSessionMenu(toSessionID('s-hidden'))).resolves.toBe('missing');
});

test('it applies no menu choice in a session outside the access', () => {
  const ctx = buildStubDaemonContext({ canSeeSession: () => false });
  const scoped = buildScopedContext(ctx, new TargetAccess([]), 'principal-a');

  expect(
    scoped.applySessionMenuChoice(toSessionID('s-hidden'), { menuToken: 'm-1', key: 'escape' }),
  ).resolves.toBe('missing');
});
