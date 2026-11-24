import { expect, test } from 'bun:test';
import { z } from 'zod';
import { buildLenientSchema } from './build-lenient-schema';

test('#buildLenientSchema keeps a key the schema does not declare, at any depth', () => {
  const item = z.object({ id: z.string() });
  const lenient = buildLenientSchema(z.object({ inner: z.array(item) }));
  const result = lenient.safeParse({ inner: [{ id: 'a', extra: 1 }], top: true });

  expect(result.data).toStrictEqual({ inner: [{ id: 'a', extra: 1 }], top: true });
});

test('#buildLenientSchema takes a string an enum does not list', () => {
  const lenient = buildLenientSchema(z.object({ state: z.enum(['up', 'down']) }));

  expect(lenient.safeParse({ state: 'frozen' }).success).toBe(true);
});

test('#buildLenientSchema takes a string a literal does not name', () => {
  const lenient = buildLenientSchema(z.object({ state: z.literal('up') }));

  expect(lenient.safeParse({ state: 'frozen' }).success).toBe(true);
});

test('#buildLenientSchema takes a value of a union that no option lists exactly', () => {
  const up = z.object({ state: z.literal('up'), count: z.number() });
  const down = z.object({ state: z.enum(['down']) });
  const lenient = buildLenientSchema(z.union([up, down]));

  expect(lenient.safeParse({ state: 'frozen' }).success).toBe(true);
});

test('#buildLenientSchema takes an answer that leaves out an optional field', () => {
  const lenient = buildLenientSchema(z.object({ id: z.string(), place: z.string().optional() }));

  expect(lenient.safeParse({ id: 'a' }).success).toBe(true);
});

test('#buildLenientSchema checks the fields of a record and a nullable value', () => {
  const entry = z.object({ count: z.number().nullable() });
  const lenient = buildLenientSchema(z.record(z.string(), entry));

  expect([
    lenient.safeParse({ first: { count: null, more: 1 } }).success,
    lenient.safeParse({ first: { count: 'x' } }).success,
  ]).toStrictEqual([true, false]);
});

test('#buildLenientSchema still refuses a field of the wrong type', () => {
  const lenient = buildLenientSchema(z.object({ count: z.number() }));

  expect(lenient.safeParse({ count: 'three' }).success).toBe(false);
});

test('#buildLenientSchema still refuses a missing required field', () => {
  const lenient = buildLenientSchema(z.object({ id: z.string() }));

  expect(lenient.safeParse({}).success).toBe(false);
});

test('#buildLenientSchema keeps a boolean literal exact', () => {
  const lenient = buildLenientSchema(z.object({ forgotten: z.literal(true) }));

  expect(lenient.safeParse({ forgotten: false }).success).toBe(false);
});

test('#buildLenientSchema checks an option the tag of a union value lists', () => {
  const up = z.object({ state: z.literal('up'), agents: z.array(z.string()) });
  const other = z.object({ state: z.enum(['down', 'refused']) });
  const lenient = buildLenientSchema(z.union([up, other]));

  expect([
    lenient.safeParse({ state: 'up', agents: 5 }).success,
    lenient.safeParse({ state: 'up', agents: ['a'] }).success,
    lenient.safeParse({ state: 'down', agents: 5 }).success,
    lenient.safeParse({ state: 'frozen' }).success,
  ]).toStrictEqual([false, true, true, true]);
});
