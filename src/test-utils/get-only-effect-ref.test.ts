import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { getOnlyEffectRef } from './get-only-effect-ref';

function setupTest() {
  using stack = new DisposableStack();

  const db = stack.use(new Database(':memory:'));

  // The table the unit reads its claims from.
  db.run('CREATE TABLE idempotency (effect_ref TEXT NOT NULL)');

  const owned = stack.move();

  return {
    db,
    [Symbol.dispose]: () => {
      owned.dispose();
    },
  };
}

test('it returns the effect ref of the only claim', () => {
  using ctx = setupTest();

  ctx.db.run("INSERT INTO idempotency (effect_ref) VALUES ('ref-one')");

  expect(getOnlyEffectRef(ctx.db)).toBe('ref-one');
});

test('it throws when the database holds no claim', () => {
  using ctx = setupTest();

  expect(() => getOnlyEffectRef(ctx.db)).toThrowWithMessage(
    Error,
    'expected one idempotency claim, found []',
  );
});

test('it throws when the database holds several claims', () => {
  using ctx = setupTest();

  ctx.db.run("INSERT INTO idempotency (effect_ref) VALUES ('ref-one'), ('ref-two')");

  expect(() => getOnlyEffectRef(ctx.db)).toThrowWithMessage(
    Error,
    'expected one idempotency claim, found ["ref-one","ref-two"]',
  );
});
