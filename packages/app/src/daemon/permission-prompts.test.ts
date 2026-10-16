import { expect, test } from 'bun:test';
import { toSessionID } from '@atc/core';
import type { EventMsg } from '@atc/protocol/wire';
import { buildStubClock } from '@atc/test-utils';
import { buildMockSession } from '../test-utils/build-mock-session';
import { PermissionPrompts } from './permission-prompts';

// The prompts over a stopped clock, with every event they send recorded.
function setupTest() {
  const emitted: EventMsg[] = [];

  const permissions = new PermissionPrompts({
    clock: buildStubClock(1_000_000),
    emitEvent: (event) => {
      emitted.push(event);
    },
    findHookScope: () => null,
  });

  return { emitted, permissions };
}

test('it opens a request when a session enters needs_you', () => {
  const ctx = setupTest();
  const s = buildMockSession({ id: toSessionID('s-1'), state: 'running' });

  ctx.permissions.recordSessionEvent('added', s);

  s.state = 'needs_you';
  s.lastMsg = 'Allow the edit?';

  ctx.permissions.recordSessionEvent('state', s);

  expect(ctx.emitted).toMatchObject([
    { ev: 'PermissionRequested', s: 's-1', message: 'Allow the edit?', respondable: false },
  ]);
});

test('it opens one request while a session stays in needs_you', () => {
  const ctx = setupTest();
  const s = buildMockSession({ id: toSessionID('s-1'), state: 'needs_you' });

  ctx.permissions.recordSessionEvent('state', s);
  ctx.permissions.recordSessionEvent('state', s);

  expect(ctx.emitted).toHaveLength(1);
});

test('it dismisses the pending request when a session leaves needs_you', () => {
  const ctx = setupTest();
  const s = buildMockSession({ id: toSessionID('s-1'), state: 'needs_you' });

  ctx.permissions.recordSessionEvent('state', s);

  s.state = 'running';

  ctx.permissions.recordSessionEvent('state', s);

  expect(ctx.emitted.at(-1)).toMatchObject({ ev: 'PermissionResolved', decision: 'dismissed' });
});

test('it dismisses the pending request of a removed session', () => {
  const ctx = setupTest();
  const s = buildMockSession({ id: toSessionID('s-1'), state: 'needs_you' });

  ctx.permissions.recordSessionEvent('state', s);
  ctx.permissions.recordSessionEvent('removed', s);

  expect(ctx.emitted.at(-1)).toMatchObject({ ev: 'PermissionResolved', decision: 'dismissed' });
});

test('it finds the session of an open request', () => {
  const ctx = setupTest();

  ctx.permissions.recordSessionEvent(
    'state',
    buildMockSession({ id: toSessionID('s-1'), state: 'needs_you' }),
  );

  const [requested] = ctx.emitted;
  const request = String(requested?.['request']);

  expect(ctx.permissions.findSessionID(request)).toBe(toSessionID('s-1'));
});

test('it refuses an answer to a request it did not open', () => {
  const ctx = setupTest();

  expect(ctx.permissions.answer('p-unknown', 'allow')).toBe('unknown');
});
