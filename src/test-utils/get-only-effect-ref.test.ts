import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { getOnlyEffectRef } from './get-only-effect-ref';

test('it returns the effect ref of the only claim', () => {
  using db = new Database(':memory:');

  db.run('CREATE TABLE idempotency (effect_ref TEXT NOT NULL)');
  db.run("INSERT INTO idempotency (effect_ref) VALUES ('ref-one')");

  expect(getOnlyEffectRef(db)).toBe('ref-one');
});

test('it throws when the database holds no claim', () => {
  using db = new Database(':memory:');

  db.run('CREATE TABLE idempotency (effect_ref TEXT NOT NULL)');

  expect(() => getOnlyEffectRef(db)).toThrowWithMessage(
    Error,
    'expected one idempotency claim, found []',
  );
});

test('it throws when the database holds several claims', () => {
  using db = new Database(':memory:');

  db.run('CREATE TABLE idempotency (effect_ref TEXT NOT NULL)');
  db.run("INSERT INTO idempotency (effect_ref) VALUES ('ref-one'), ('ref-two')");

  expect(() => getOnlyEffectRef(db)).toThrowWithMessage(
    Error,
    'expected one idempotency claim, found ["ref-one","ref-two"]',
  );
});
