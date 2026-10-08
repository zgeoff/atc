import { expect, test } from 'bun:test';
import { buildStubHostHold } from './build-stub-host-hold';

test('it lets an operation through while unarmed', async () => {
  const stub = buildStubHostHold();

  await stub.waitForRelease();

  expect(Bun.peek.status(stub.entered)).toBe('pending');
});

test('it reports the entry of an armed operation and holds it until the release', async () => {
  const stub = buildStubHostHold();

  stub.startHold();

  const held = stub.waitForRelease();

  await stub.entered;

  expect(Bun.peek.status(held)).toBe('pending');
});

test('it lets a held operation finish once released', () => {
  const stub = buildStubHostHold();

  stub.startHold();

  const held = stub.waitForRelease();

  stub.release();

  expect(held).resolves.toBeUndefined();
});
