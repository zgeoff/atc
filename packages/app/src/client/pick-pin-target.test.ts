import { expect, test } from 'bun:test';
import { pickPinTarget } from './pick-pin-target';

test('it picks a top-level session itself', () => {
  const session = { id: 'auth', parent: null, pinned: false };

  expect(pickPinTarget(session, [session])).toBe(session);
});

test('it picks the parent of a sub-session without a pin of its own', () => {
  const parent = { id: 'wrangler', parent: null, pinned: true };
  const child = { id: 'worker', parent: 'wrangler', pinned: false };

  expect(pickPinTarget(child, [parent, child])).toBe(parent);
});

test('it picks a sub-session that carries a pin of its own', () => {
  const parent = { id: 'wrangler', parent: null, pinned: false };
  const child = { id: 'worker', parent: 'wrangler', pinned: true };

  expect(pickPinTarget(child, [parent, child])).toBe(child);
});

test('it picks a sub-session whose parent is not listed', () => {
  const child = { id: 'worker', parent: 'wrangler', pinned: false };

  expect(pickPinTarget(child, [child])).toBe(child);
});
