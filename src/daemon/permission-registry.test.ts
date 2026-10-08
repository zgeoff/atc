import { expect, expectTypeOf, test } from 'bun:test';
import type { AgentSessionID } from '../shared/agent-session-id';
import { toSessionID } from '../shared/to-session-id';
import { buildStubClock } from '../test-utils/build-stub-clock';
import { PermissionRegistry } from './permission-registry';

test('it emits the request with its respondable flag on open', () => {
  const registry = new PermissionRegistry(60_000, buildStubClock(0));

  const requests: unknown[] = [];

  registry.onRequested = (req) => {
    requests.push(req);
  };

  const req = registry.open(toSessionID('s1'), 'needs permission', false);

  expect(requests).toStrictEqual([
    { id: req.id, sessionID: 's1', message: 'needs permission', respondable: false },
  ]);
});

test('it applies the first responder decision', () => {
  const registry = new PermissionRegistry(60_000, buildStubClock(0));

  const resolutions: [string, string][] = [];

  registry.onResolved = (id, decision) => {
    resolutions.push([id, decision]);
  };

  const req = registry.open(toSessionID('s1'), 'allow tool?', true);
  const answered = registry.answer(req.id, 'allow');

  expect(answered).toBe('ok');
  expect(resolutions).toStrictEqual([[req.id, 'allow']]);
});

test('it reports already_answered to a second responder', () => {
  const registry = new PermissionRegistry(60_000, buildStubClock(0));

  const req = registry.open(toSessionID('s1'), 'allow tool?', true);

  registry.answer(req.id, 'allow');

  expect(registry.answer(req.id, 'deny')).toBe('already_answered');
});

test('it reports unsupported for a request a client cannot answer structurally', () => {
  const registry = new PermissionRegistry(60_000, buildStubClock(0));

  const req = registry.open(toSessionID('s1'), 'needs permission', false);

  expect(registry.answer(req.id, 'allow')).toBe('unsupported');
});

test('it reports unknown for a request that never existed', () => {
  const registry = new PermissionRegistry(60_000, buildStubClock(0));

  expect(registry.answer('p999', 'allow')).toBe('unknown');
});

test('it times an unanswered request out to deny', () => {
  const clock = buildStubClock(0);

  const registry = new PermissionRegistry(30, clock);

  const resolutions: [string, string][] = [];

  registry.onResolved = (id, decision) => {
    resolutions.push([id, decision]);
  };

  const req = registry.open(toSessionID('s1'), 'allow tool?', true);

  clock.advance(30);

  expect(resolutions).toStrictEqual([[req.id, 'deny']]);
});

test('it never times out an answered request a second time', () => {
  const clock = buildStubClock(0);

  const registry = new PermissionRegistry(30, clock);

  const resolutions: [string, string][] = [];

  registry.onResolved = (id, decision) => {
    resolutions.push([id, decision]);
  };

  const req = registry.open(toSessionID('s1'), 'allow tool?', true);

  registry.answer(req.id, 'allow');
  clock.advance(30);

  expect(resolutions).toStrictEqual([[req.id, 'allow']]);
});

test('it resolves every pending request for a session as dismissed', () => {
  const registry = new PermissionRegistry(60_000, buildStubClock(0));

  const resolutions: [string, string][] = [];

  registry.onResolved = (id, decision) => {
    resolutions.push([id, decision]);
  };

  const first = registry.open(toSessionID('s1'), 'one', true);
  const second = registry.open(toSessionID('s1'), 'two', false);

  registry.open(toSessionID('s2'), 'other', true);
  registry.answerAll(toSessionID('s1'), 'dismissed');

  expect(resolutions).toStrictEqual([
    [first.id, 'dismissed'],
    [second.id, 'dismissed'],
  ]);
});

test("it leaves another session's request open when it dismisses a session", () => {
  const registry = new PermissionRegistry(60_000, buildStubClock(0));

  registry.open(toSessionID('s1'), 'one', true);

  const other = registry.open(toSessionID('s2'), 'other', true);

  registry.answerAll(toSessionID('s1'), 'dismissed');

  expect(registry.answer(other.id, 'allow')).toBe('ok');
});

test('it refuses an agent-minted session id as the session of a request', () => {
  expectTypeOf<AgentSessionID>().not.toExtend<Parameters<PermissionRegistry['open']>[0]>();
});
