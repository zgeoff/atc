import { expect, expectTypeOf, mock, test } from 'bun:test';
import type { AgentSessionID } from '@atc/core';
import { toSessionID } from '@atc/core';
import { buildStubClock } from '@atc/test-utils';
import type { PermissionRequest } from './permission-registry';
import { PermissionRegistry } from './permission-registry';

test('it emits the request with its respondable flag on open', () => {
  const onRequested = mock<(req: PermissionRequest) => void>();

  const registry = new PermissionRegistry(
    { onRequested, onResolved: () => {} },
    60_000,
    buildStubClock(0),
  );

  const req = registry.open(toSessionID('s1'), 'needs permission', false);

  expect(onRequested).toHaveBeenCalledExactlyOnceWith({
    id: req.id,
    sessionID: 's1',
    message: 'needs permission',
    respondable: false,
  });
});

test('it applies the first responder decision', () => {
  const onResolved = mock<(id: string, decision: string) => void>();

  const registry = new PermissionRegistry(
    { onRequested: () => {}, onResolved },
    60_000,
    buildStubClock(0),
  );

  const req = registry.open(toSessionID('s1'), 'allow tool?', true);
  const answered = registry.answer(req.id, 'allow');

  expect(answered).toBe('ok');
  expect(onResolved.mock.calls).toStrictEqual([[req.id, 'allow']]);
});

test('it reports already_answered to a second responder', () => {
  const registry = new PermissionRegistry(
    { onRequested: () => {}, onResolved: () => {} },
    60_000,
    buildStubClock(0),
  );

  const req = registry.open(toSessionID('s1'), 'allow tool?', true);

  registry.answer(req.id, 'allow');

  expect(registry.answer(req.id, 'deny')).toBe('already_answered');
});

test('it reports unknown for the oldest answered request once 1000 later ones are answered', () => {
  const registry = new PermissionRegistry(
    { onRequested: () => {}, onResolved: () => {} },
    60_000,
    buildStubClock(0),
  );

  const requests = Array.from({ length: 1001 }, () =>
    registry.open(toSessionID('s1'), 'allow tool?', true),
  );

  for (const req of requests) {
    registry.answer(req.id, 'allow');
  }

  expect(registry.answer('p1', 'deny')).toBe('unknown');
});

test('it reports already_answered for each of the 1000 most recently answered requests', () => {
  const registry = new PermissionRegistry(
    { onRequested: () => {}, onResolved: () => {} },
    60_000,
    buildStubClock(0),
  );

  const requests = Array.from({ length: 1001 }, () =>
    registry.open(toSessionID('s1'), 'allow tool?', true),
  );

  for (const req of requests) {
    registry.answer(req.id, 'allow');
  }

  expect(requests.slice(1).map((req) => registry.answer(req.id, 'deny'))).toSatisfyAll(
    (result: string) => result === 'already_answered',
  );
});

test('it reports unsupported for a request a client cannot answer structurally', () => {
  const registry = new PermissionRegistry(
    { onRequested: () => {}, onResolved: () => {} },
    60_000,
    buildStubClock(0),
  );

  const req = registry.open(toSessionID('s1'), 'needs permission', false);

  expect(registry.answer(req.id, 'allow')).toBe('unsupported');
});

test('it reports unknown for a request that never existed', () => {
  const registry = new PermissionRegistry(
    { onRequested: () => {}, onResolved: () => {} },
    60_000,
    buildStubClock(0),
  );

  expect(registry.answer('p999', 'allow')).toBe('unknown');
});

test('it times an unanswered request out to deny', () => {
  const clock = buildStubClock(0);
  const onResolved = mock<(id: string, decision: string) => void>();

  const registry = new PermissionRegistry({ onRequested: () => {}, onResolved }, 30, clock);

  const req = registry.open(toSessionID('s1'), 'allow tool?', true);

  clock.advance(30);

  expect(onResolved.mock.calls).toStrictEqual([[req.id, 'deny']]);
});

test('it never times out an answered request a second time', () => {
  const clock = buildStubClock(0);
  const onResolved = mock<(id: string, decision: string) => void>();

  const registry = new PermissionRegistry({ onRequested: () => {}, onResolved }, 30, clock);

  const req = registry.open(toSessionID('s1'), 'allow tool?', true);

  registry.answer(req.id, 'allow');
  clock.advance(30);

  expect(onResolved.mock.calls).toStrictEqual([[req.id, 'allow']]);
});

test('it resolves every pending request for a session as dismissed', () => {
  const onResolved = mock<(id: string, decision: string) => void>();

  const registry = new PermissionRegistry(
    { onRequested: () => {}, onResolved },
    60_000,
    buildStubClock(0),
  );

  const first = registry.open(toSessionID('s1'), 'one', true);
  const second = registry.open(toSessionID('s1'), 'two', false);

  registry.open(toSessionID('s2'), 'other', true);
  registry.answerAll(toSessionID('s1'), 'dismissed');

  expect(onResolved.mock.calls).toStrictEqual([
    [first.id, 'dismissed'],
    [second.id, 'dismissed'],
  ]);
});

test("it leaves another session's request open when it dismisses a session", () => {
  const registry = new PermissionRegistry(
    { onRequested: () => {}, onResolved: () => {} },
    60_000,
    buildStubClock(0),
  );

  registry.open(toSessionID('s1'), 'one', true);

  const other = registry.open(toSessionID('s2'), 'other', true);

  registry.answerAll(toSessionID('s1'), 'dismissed');

  expect(registry.answer(other.id, 'allow')).toBe('ok');
});

test('it refuses an agent-minted session id as the session of a request', () => {
  expectTypeOf<AgentSessionID>().not.toExtend<Parameters<PermissionRegistry['open']>[0]>();
});
