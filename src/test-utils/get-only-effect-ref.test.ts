import { Database } from 'bun:sqlite';
import { expect, onTestFinished, test } from 'bun:test';
import { getOnlyEffectRef } from './get-only-effect-ref';

function setupTest() {
  const db = new Database(':memory:');

  onTestFinished(() => {
    db.close();
  });

  // The table the unit reads its claims from.
  db.run('CREATE TABLE idempotency (effect_ref TEXT NOT NULL)');

  return { db };
}

test('it returns the effect ref of the only claim', () => {
  const ctx = setupTest();

  ctx.db.run("INSERT INTO idempotency (effect_ref) VALUES ('ref-one')");

  expect(getOnlyEffectRef(ctx.db)).toBe('ref-one');
});

test('it throws when the database holds no claim', () => {
  const ctx = setupTest();

  expect(() => getOnlyEffectRef(ctx.db)).toThrowWithMessage(
    Error,
    'expected one idempotency claim, found []',
  );
});

test('it throws when the database holds several claims', () => {
  const ctx = setupTest();

  ctx.db.run("INSERT INTO idempotency (effect_ref) VALUES ('ref-one'), ('ref-two')");

  expect(() => getOnlyEffectRef(ctx.db)).toThrowWithMessage(
    Error,
    'expected one idempotency claim, found ["ref-one","ref-two"]',
  );
});
