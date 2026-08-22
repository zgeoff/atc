import { expect, test } from 'bun:test';
import { PermissionRegistry } from './permission-registry';
import type { SessionID } from './session-id';

function toSessionID(id: string): SessionID {
  // oxlint-disable-next-line no-unsafe-type-assertion -- test fixture literals stand in for minted session ids
  return id as SessionID;
}

test('it emits the request with its respondable flag on open', () => {
  const registry = new PermissionRegistry();

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
  const registry = new PermissionRegistry();

  const resolutions: [string, string][] = [];

  registry.onResolved = (id, decision) => {
    resolutions.push([id, decision]);
  };

  const req = registry.open(toSessionID('s1'), 'allow tool?', true);

  expect(registry.answer(req.id, 'allow')).toBe('ok');
  expect(resolutions).toStrictEqual([[req.id, 'allow']]);
});

test('it reports already_answered to a second responder', () => {
  const registry = new PermissionRegistry();

  const req = registry.open(toSessionID('s1'), 'allow tool?', true);

  registry.answer(req.id, 'allow');

  expect(registry.answer(req.id, 'deny')).toBe('already_answered');
});

test('it reports unsupported for a request a client cannot answer structurally', () => {
  const registry = new PermissionRegistry();

  const req = registry.open(toSessionID('s1'), 'needs permission', false);

  expect(registry.answer(req.id, 'allow')).toBe('unsupported');
});

test('it reports unknown for a request that never existed', () => {
  const registry = new PermissionRegistry();

  expect(registry.answer('p999', 'allow')).toBe('unknown');
});

test('it times an unanswered request out to deny', async () => {
  const registry = new PermissionRegistry(30);

  const resolutions: [string, string][] = [];

  registry.onResolved = (id, decision) => {
    resolutions.push([id, decision]);
  };

  const req = registry.open(toSessionID('s1'), 'allow tool?', true);
  const deadline = Date.now() + 2000;

  while (resolutions.length === 0 && Date.now() < deadline) {
    await Bun.sleep(10);
  }

  expect(resolutions).toStrictEqual([[req.id, 'deny']]);
});

test('it never times out an answered request a second time', async () => {
  const registry = new PermissionRegistry(30);

  const resolutions: [string, string][] = [];

  registry.onResolved = (id, decision) => {
    resolutions.push([id, decision]);
  };

  const req = registry.open(toSessionID('s1'), 'allow tool?', true);

  registry.answer(req.id, 'allow');

  // Waits out the timeout window: the only observable signal is that no
  // second resolution arrives after it passes.
  await Bun.sleep(80);

  expect(resolutions).toStrictEqual([[req.id, 'allow']]);
});

test('it resolves every pending request for a session as dismissed', () => {
  const registry = new PermissionRegistry();

  const resolutions: [string, string][] = [];

  registry.onResolved = (id, decision) => {
    resolutions.push([id, decision]);
  };

  const first = registry.open(toSessionID('s1'), 'one', true);
  const second = registry.open(toSessionID('s1'), 'two', false);
  const other = registry.open(toSessionID('s2'), 'other', true);

  registry.answerAll(toSessionID('s1'), 'dismissed');

  expect(resolutions).toStrictEqual([
    [first.id, 'dismissed'],
    [second.id, 'dismissed'],
  ]);

  expect(registry.answer(other.id, 'allow')).toBe('ok');
});
