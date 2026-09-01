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

test('it updates dims only for an attached client', () => {
  const registry = new AttachRegistry<string>();

  registry.attach(toSessionID('s1'), 'a', { cols: 100, rows: 24 });

  expect(registry.updateDims(toSessionID('s1'), 'a', { cols: 90, rows: 20 })).toBeTrue();
  expect(registry.updateDims(toSessionID('s1'), 'stranger', { cols: 10, rows: 10 })).toBeFalse();
  expect(registry.findEffectiveDims(toSessionID('s1'))).toStrictEqual({ cols: 90, rows: 20 });
});

test('it reports true for a detach that removes an attachment and false for the repeat', () => {
  const registry = new AttachRegistry<string>();

  registry.attach(toSessionID('s1'), 'a', { cols: 80, rows: 24 });

  expect(registry.detach(toSessionID('s1'), 'a')).toBeTrue();
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

  expect(affected).toStrictEqual([toSessionID('s1'), toSessionID('s2')]);
  expect(registry.collectClients(toSessionID('s1'))).toStrictEqual([]);
  expect(registry.collectClients(toSessionID('s2'))).toStrictEqual(['b']);
});

test('it keeps other sessions when one is removed', () => {
  const registry = new AttachRegistry<string>();

  registry.attach(toSessionID('s1'), 'a', { cols: 80, rows: 24 });
  registry.attach(toSessionID('s2'), 'a', { cols: 80, rows: 24 });
  registry.removeSession(toSessionID('s1'));

  expect(registry.hasClient(toSessionID('s1'), 'a')).toBeFalse();
  expect(registry.hasClient(toSessionID('s2'), 'a')).toBeTrue();
});
