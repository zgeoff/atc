import { expect, test } from 'bun:test';
import { toSessionID } from '../shared/to-session-id';
import { AttachRegistry } from './attach-registry';

test('it reports the smallest width and height across attached clients', () => {
  const registry = new AttachRegistry<string>();

  registry.attach(toSessionID('s1'), 'a', { cols: 100, rows: 24 });
  registry.attach(toSessionID('s1'), 'b', { cols: 80, rows: 30 });

  expect(registry.findEffectiveDims(toSessionID('s1'))).toStrictEqual({ cols: 80, rows: 24 });
});

test('it reports no dims for a session with no attached clients', () => {
  const registry = new AttachRegistry<string>();

  expect(registry.findEffectiveDims(toSessionID('s1'))).toBeNull();
});

test('it updates the dims of an attached client', () => {
  const registry = new AttachRegistry<string>();

  registry.attach(toSessionID('s1'), 'a', { cols: 100, rows: 24 });

  const updated = registry.updateDims(toSessionID('s1'), 'a', { cols: 90, rows: 20 });

  expect({ updated, dims: registry.findEffectiveDims(toSessionID('s1')) }).toStrictEqual({
    updated: true,
    dims: { cols: 90, rows: 20 },
  });
});

test('it refuses a dims update from a client that is not attached', () => {
  const registry = new AttachRegistry<string>();

  registry.attach(toSessionID('s1'), 'a', { cols: 100, rows: 24 });

  const updated = registry.updateDims(toSessionID('s1'), 'stranger', { cols: 10, rows: 10 });

  expect({ updated, dims: registry.findEffectiveDims(toSessionID('s1')) }).toStrictEqual({
    updated: false,
    dims: { cols: 100, rows: 24 },
  });
});

test('it reports true for a detach that removes an attachment', () => {
  const registry = new AttachRegistry<string>();

  registry.attach(toSessionID('s1'), 'a', { cols: 80, rows: 24 });

  expect(registry.detach(toSessionID('s1'), 'a')).toBeTrue();
});

test('it reports false for a repeat detach', () => {
  const registry = new AttachRegistry<string>();

  registry.attach(toSessionID('s1'), 'a', { cols: 80, rows: 24 });
  registry.detach(toSessionID('s1'), 'a');

  expect(registry.detach(toSessionID('s1'), 'a')).toBeFalse();
});

test('it reports false for a detach of a session it never tracked', () => {
  const registry = new AttachRegistry<string>();

  expect(registry.detach(toSessionID('s1'), 'stranger')).toBeFalse();
});

test('it detaches one client from every session it watched', () => {
  const registry = new AttachRegistry<string>();

  registry.attach(toSessionID('s1'), 'a', { cols: 80, rows: 24 });
  registry.attach(toSessionID('s2'), 'a', { cols: 80, rows: 24 });
  registry.attach(toSessionID('s2'), 'b', { cols: 100, rows: 30 });

  const affected = registry.detachAll('a');

  expect({
    affected,
    s1: registry.collectClients(toSessionID('s1')),
    s2: registry.collectClients(toSessionID('s2')),
  }).toStrictEqual({ affected: [toSessionID('s1'), toSessionID('s2')], s1: [], s2: ['b'] });
});

test('it keeps other sessions when one is removed', () => {
  const registry = new AttachRegistry<string>();

  registry.attach(toSessionID('s1'), 'a', { cols: 80, rows: 24 });
  registry.attach(toSessionID('s2'), 'a', { cols: 80, rows: 24 });

  // The client watches both sessions, so only its attachment to s1 may go.
  registry.removeSession(toSessionID('s1'));

  expect({
    s1: registry.hasClient(toSessionID('s1'), 'a'),
    s2: registry.hasClient(toSessionID('s2'), 'a'),
  }).toStrictEqual({ s1: false, s2: true });
});
