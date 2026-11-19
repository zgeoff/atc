import { expect, test } from 'bun:test';
import { readOnlyEffectRef } from './read-only-effect-ref';

test('it reads the effect ref of the only claim', async () => {
  const store = { readIdempotencyKeys: () => Promise.resolve([{ effectRef: 'ref-one' }]) };

  const ref = await readOnlyEffectRef(store);

  expect(ref).toBe('ref-one');
});

test('it throws when the store holds no claim', () => {
  const store = { readIdempotencyKeys: () => Promise.resolve([]) };

  expect(readOnlyEffectRef(store)).rejects.toThrowWithMessage(
    Error,
    'expected one idempotency claim, found []',
  );
});

test('it throws when the store holds several claims', () => {
  const store = {
    readIdempotencyKeys: () =>
      Promise.resolve([{ effectRef: 'ref-one' }, { effectRef: 'ref-two' }]),
  };

  expect(readOnlyEffectRef(store)).rejects.toThrowWithMessage(
    Error,
    'expected one idempotency claim, found ["ref-one","ref-two"]',
  );
});
