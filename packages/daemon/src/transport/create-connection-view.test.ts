import { expect, test } from 'bun:test';
import { toSessionID } from '@atc/core';
import type { SessionID } from '@atc/core';
import { PROTOCOL_V } from '@atc/protocol/wire';
import { buildMockSessionDescriptor } from '@atc/test-utils';
import { buildTargetAccessFromGrants } from '../auth/build-target-access-from-grants';
import { createConnectionView } from './create-connection-view';

// A view over a fleet the test edits: the sessions the daemon holds, and
// the ones the access reaches.
function setupTest() {
  const held = new Set<SessionID>();
  const reached = new Set<SessionID>();

  const view = createConnectionView({
    findSessionGrant: (id) =>
      held.has(id) ? { target: 'local', targetIdentity: 'local-pty:test' } : null,
    canSeeSession: (id) => reached.has(id),
    collectSessions: () => [...held].map((id) => buildMockSessionDescriptor({ id })),
  });

  return { held, reached, view, access: buildTargetAccessFromGrants([]) };
}

test('it sends the event of a session in reach', () => {
  const ctx = setupTest();
  const event = { version: PROTOCOL_V, ev: 'SessionState', sessionID: 's-1' };

  ctx.held.add(toSessionID('s-1'));
  ctx.reached.add(toSessionID('s-1'));

  expect(ctx.view.updateView(event, ctx.access)).toStrictEqual({
    events: [event],
    withdrawn: [],
  });
});

test('it withholds the event of a session out of reach', () => {
  const ctx = setupTest();

  ctx.held.add(toSessionID('s-1'));

  const update = ctx.view.updateView(
    { version: PROTOCOL_V, ev: 'SessionState', sessionID: 's-1' },
    ctx.access,
  );

  expect(update).toStrictEqual({ events: [], withdrawn: [] });
});

test('it removes a shown session from the view once it leaves reach', () => {
  const ctx = setupTest();

  ctx.held.add(toSessionID('s-1'));
  ctx.held.add(toSessionID('s-2'));
  ctx.reached.add(toSessionID('s-1'));
  ctx.reached.add(toSessionID('s-2'));
  ctx.view.startView(ctx.access);
  ctx.reached.delete(toSessionID('s-1'));

  const event = { version: PROTOCOL_V, ev: 'SessionState', sessionID: 's-2' };

  expect(ctx.view.updateView(event, ctx.access)).toStrictEqual({
    events: [{ version: PROTOCOL_V, ev: 'SessionRemoved', sessionID: 's-1' }, event],
    withdrawn: [toSessionID('s-1')],
  });
});

test('it adds a withheld session to the view once it comes into reach', () => {
  const ctx = setupTest();

  ctx.held.add(toSessionID('s-1'));
  ctx.view.startView(ctx.access);
  ctx.reached.add(toSessionID('s-1'));

  const update = ctx.view.updateView(
    { version: PROTOCOL_V, ev: 'SessionState', sessionID: 's-1' },
    ctx.access,
  );

  expect(update.events.map((event) => event.ev)).toStrictEqual(['SessionAdded', 'SessionState']);
});

test('it sends the removal of a shown session the daemon no longer holds', () => {
  const ctx = setupTest();
  const event = { version: PROTOCOL_V, ev: 'SessionRemoved', sessionID: 's-1' };

  ctx.held.add(toSessionID('s-1'));
  ctx.reached.add(toSessionID('s-1'));
  ctx.view.startView(ctx.access);
  ctx.held.delete(toSessionID('s-1'));
  ctx.reached.delete(toSessionID('s-1'));

  expect(ctx.view.updateView(event, ctx.access)).toStrictEqual({
    events: [event],
    withdrawn: [],
  });
});

test('it sends the end of a permission request it was shown after its session is gone', () => {
  const ctx = setupTest();
  const resolved = { version: PROTOCOL_V, ev: 'PermissionResolved', request: 'p-1' };

  ctx.held.add(toSessionID('s-1'));
  ctx.reached.add(toSessionID('s-1'));

  ctx.view.updateView(
    { version: PROTOCOL_V, ev: 'PermissionRequested', sessionID: 's-1', request: 'p-1' },
    ctx.access,
  );

  ctx.held.delete(toSessionID('s-1'));
  ctx.reached.delete(toSessionID('s-1'));

  expect(ctx.view.updateView(resolved, ctx.access)).toStrictEqual({
    events: [resolved],
    withdrawn: [],
  });
});

test('it withholds the end of a permission request it was never shown', () => {
  const ctx = setupTest();

  const update = ctx.view.updateView(
    { version: PROTOCOL_V, ev: 'PermissionResolved', request: 'p-1' },
    ctx.access,
  );

  expect(update).toStrictEqual({ events: [], withdrawn: [] });
});
