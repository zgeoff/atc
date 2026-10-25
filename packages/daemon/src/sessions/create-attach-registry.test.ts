import { expect, test } from 'bun:test';
import { toSessionID } from '@atcx/contract';
import { createAttachRegistry } from './create-attach-registry';

test('it reports the smallest width and height across attached clients', () => {
  const registry = createAttachRegistry<string>();

  registry.attach(toSessionID('s1'), 'a', { cols: 100, rows: 24 });
  registry.attach(toSessionID('s1'), 'b', { cols: 80, rows: 30 });

  expect(registry.findEffectiveDims(toSessionID('s1'))).toStrictEqual({ cols: 80, rows: 24 });
});

test('it reports no dims for a session with no attached clients', () => {
  const registry = createAttachRegistry<string>();

  expect(registry.findEffectiveDims(toSessionID('s1'))).toBeNull();
});

test('it updates the dims of an attached client', () => {
  const registry = createAttachRegistry<string>();

  registry.attach(toSessionID('s1'), 'a', { cols: 100, rows: 24 });

  const updated = registry.updateDims(toSessionID('s1'), 'a', { cols: 90, rows: 20 });

  expect(updated).toBeTrue();
  expect(registry.findEffectiveDims(toSessionID('s1'))).toStrictEqual({ cols: 90, rows: 20 });
});

test('it refuses a dims update from a client that is not attached', () => {
  const registry = createAttachRegistry<string>();

  registry.attach(toSessionID('s1'), 'a', { cols: 100, rows: 24 });

  const updated = registry.updateDims(toSessionID('s1'), 'stranger', { cols: 10, rows: 10 });

  expect(updated).toBeFalse();
  expect(registry.findEffectiveDims(toSessionID('s1'))).toStrictEqual({ cols: 100, rows: 24 });
});

test('it reports true for a detach that removes an attachment', () => {
  const registry = createAttachRegistry<string>();

  registry.attach(toSessionID('s1'), 'a', { cols: 80, rows: 24 });

  expect(registry.removeClient(toSessionID('s1'), 'a')).toBeTrue();
});

test('it reports false for a repeat detach', () => {
  const registry = createAttachRegistry<string>();

  registry.attach(toSessionID('s1'), 'a', { cols: 80, rows: 24 });
  registry.removeClient(toSessionID('s1'), 'a');

  expect(registry.removeClient(toSessionID('s1'), 'a')).toBeFalse();
});

test('it reports false for a detach of a session it never tracked', () => {
  const registry = createAttachRegistry<string>();

  expect(registry.removeClient(toSessionID('s1'), 'stranger')).toBeFalse();
});

test('it detaches one client from every session it watched', () => {
  const registry = createAttachRegistry<string>();

  registry.attach(toSessionID('s1'), 'a', { cols: 80, rows: 24 });
  registry.attach(toSessionID('s2'), 'a', { cols: 80, rows: 24 });
  registry.attach(toSessionID('s2'), 'b', { cols: 100, rows: 30 });

  const affected = registry.detachAll('a');

  expect(affected).toStrictEqual([toSessionID('s1'), toSessionID('s2')]);
  expect(registry.collectClients(toSessionID('s1'))).toStrictEqual([]);
  expect(registry.collectClients(toSessionID('s2'))).toStrictEqual(['b']);
});

test('it keeps other sessions when one is removed', () => {
  const registry = createAttachRegistry<string>();

  registry.attach(toSessionID('s1'), 'a', { cols: 80, rows: 24 });
  registry.attach(toSessionID('s2'), 'a', { cols: 80, rows: 24 });

  // The client watches both sessions, so only its attachment to s1 may go.
  registry.removeSession(toSessionID('s1'));

  expect(registry.hasClient(toSessionID('s1'), 'a')).toBeFalse();
  expect(registry.hasClient(toSessionID('s2'), 'a')).toBeTrue();
});
