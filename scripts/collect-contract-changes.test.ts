import { expect, test } from 'bun:test';
import { z } from 'zod';
import { collectContractChanges } from './collect-contract-changes';
import { buildContractSchemas } from './test-utils/build-contract-schemas';

function setupTest() {
  return {
    collect: (
      before: Parameters<typeof buildContractSchemas>[0],
      after: Parameters<typeof buildContractSchemas>[0],
    ) => collectContractChanges(buildContractSchemas(before), buildContractSchemas(after)),
  };
}

test('it finds nothing in a contract that did not change', () => {
  const schemas = buildContractSchemas({
    input: z.object({ cwd: z.string(), name: z.string().optional() }),
    output: z.object({ id: z.string() }),
  });

  expect(collectContractChanges(schemas, schemas)).toStrictEqual([]);
});

test('it finds a removed input field', () => {
  const ctx = setupTest();
  const output = z.object({ id: z.string() });

  const changes = ctx.collect(
    {
      input: z.object({ cwd: z.string(), name: z.string().optional() }),
      output,
    },
    { input: z.object({ cwd: z.string() }), output },
  );

  expect(changes).toStrictEqual([
    {
      kind: 'breaking',
      method: 'session.spawn',
      path: 'name',
      message: 'input: the field is removed or renamed',
    },
  ]);
});

test('it finds a removed answer field', () => {
  const ctx = setupTest();
  const input = z.object({ cwd: z.string() });

  const changes = ctx.collect(
    { input, output: z.object({ id: z.string() }) },
    { input, output: z.object({}) },
  );

  expect(changes).toStrictEqual([
    {
      kind: 'breaking',
      method: 'session.spawn',
      path: 'id',
      message: 'answer: the field is removed or renamed',
    },
  ]);
});

test('it finds a removed procedure', () => {
  const before = buildContractSchemas({ input: z.object({}), output: z.object({}) });
  const changes = collectContractChanges(before, { procedures: {}, event: before.event });

  expect(changes).toStrictEqual([
    {
      kind: 'breaking',
      method: 'session.spawn',
      path: '',
      message: 'the procedure session.spawn is removed or renamed',
    },
  ]);
});

test('it passes a new procedure', () => {
  const before = buildContractSchemas({ input: z.object({}), output: z.object({}) });

  const added = buildContractSchemas({
    method: 'session.pause',
    input: z.object({}),
    output: z.object({}),
  });

  const after = { ...before, procedures: { ...before.procedures, ...added.procedures } };

  expect(collectContractChanges(before, after)).toStrictEqual([]);
});

test('it finds a new optional input field as one that needs a list entry', () => {
  const ctx = setupTest();
  const output = z.object({});

  const changes = ctx.collect(
    { input: z.object({ cwd: z.string() }), output },
    {
      input: z.object({ cwd: z.string(), region: z.string().optional() }),
      output,
    },
  );

  expect(changes).toStrictEqual([
    {
      kind: 'new-input-field',
      method: 'session.spawn',
      path: 'region',
      message: 'a new input field',
    },
  ]);
});

test('it finds a new nested input field by its dotted path', () => {
  const ctx = setupTest();
  const output = z.object({});
  const before = z.object({ opts: z.object({ first: z.string() }) });
  const optional = z.string().optional();
  const after = z.object({ opts: z.object({ first: z.string(), second: optional }) });
  const changes = ctx.collect({ input: before, output }, { input: after, output });

  expect(changes).toStrictEqual([
    {
      kind: 'new-input-field',
      method: 'session.spawn',
      path: 'opts.second',
      message: 'a new input field',
    },
  ]);
});

test('it finds a new required input field as breaking', () => {
  const ctx = setupTest();
  const output = z.object({});

  const changes = ctx.collect(
    { input: z.object({ cwd: z.string() }), output },
    { input: z.object({ cwd: z.string(), region: z.string() }), output },
  );

  expect(changes).toStrictEqual([
    {
      kind: 'breaking',
      method: 'session.spawn',
      path: 'region',
      message: 'input: the new field is required',
    },
  ]);
});

test('it passes a new answer field', () => {
  const ctx = setupTest();
  const input = z.object({});

  const changes = ctx.collect(
    { input, output: z.object({ id: z.string() }) },
    { input, output: z.object({ id: z.string(), region: z.string() }) },
  );

  expect(changes).toStrictEqual([]);
});

test('it finds an input field that is required now', () => {
  const ctx = setupTest();
  const output = z.object({});

  const changes = ctx.collect(
    { input: z.object({ name: z.string().optional() }), output },
    { input: z.object({ name: z.string() }), output },
  );

  expect(changes).toStrictEqual([
    {
      kind: 'breaking',
      method: 'session.spawn',
      path: 'name',
      message: 'input: the field is required now',
    },
  ]);
});

test('it finds an answer field that is optional now', () => {
  const ctx = setupTest();
  const input = z.object({});

  const changes = ctx.collect(
    { input, output: z.object({ id: z.string() }) },
    { input, output: z.object({ id: z.string().optional() }) },
  );

  expect(changes).toStrictEqual([
    {
      kind: 'breaking',
      method: 'session.spawn',
      path: 'id',
      message: 'answer: the field is optional now',
    },
  ]);
});

test('it finds an input type that narrowed', () => {
  const ctx = setupTest();
  const output = z.object({});
  const wide = z.object({ cwd: z.union([z.string(), z.number()]) });
  const narrow = z.object({ cwd: z.string() });
  const changes = ctx.collect({ input: wide, output }, { input: narrow, output });

  expect(changes.map((change) => change.kind)).toStrictEqual(['breaking']);
});

test('it passes an input type that widened', () => {
  const ctx = setupTest();
  const output = z.object({});
  const wide = z.object({ cwd: z.union([z.string(), z.number()]) });
  const narrow = z.object({ cwd: z.string() });
  const changes = ctx.collect({ input: narrow, output }, { input: wide, output });

  expect(changes).toStrictEqual([]);
});

test('it finds an answer type that changed', () => {
  const ctx = setupTest();
  const input = z.object({});

  const changes = ctx.collect(
    { input, output: z.object({ id: z.string() }) },
    { input, output: z.object({ id: z.number() }) },
  );

  expect(changes.map((change) => change.kind)).toStrictEqual(['breaking']);
});

test('it finds an input enum that lost a value', () => {
  const ctx = setupTest();
  const output = z.object({});

  const changes = ctx.collect(
    { input: z.object({ mode: z.enum(['a', 'b']) }), output },
    { input: z.object({ mode: z.enum(['a']) }), output },
  );

  expect(changes.map((change) => change.kind)).toStrictEqual(['breaking']);
});

test('it passes an input enum that gained a value', () => {
  const ctx = setupTest();
  const output = z.object({});

  const changes = ctx.collect(
    { input: z.object({ mode: z.enum(['a']) }), output },
    { input: z.object({ mode: z.enum(['a', 'b']) }), output },
  );

  expect(changes).toStrictEqual([]);
});

test('it passes an answer enum that gained a value', () => {
  const ctx = setupTest();
  const input = z.object({});

  const changes = ctx.collect(
    { input, output: z.object({ state: z.enum(['a']) }) },
    { input, output: z.object({ state: z.enum(['a', 'b']) }) },
  );

  expect(changes).toStrictEqual([]);
});

test('it finds an input bound that narrowed', () => {
  const ctx = setupTest();
  const output = z.object({});

  const changes = ctx.collect(
    { input: z.object({ cols: z.number().max(4096) }), output },
    { input: z.object({ cols: z.number().max(100) }), output },
  );

  expect(changes.map((change) => change.kind)).toStrictEqual(['breaking']);
});

test('it passes an event kind that a release adds', () => {
  const ctx = setupTest();
  const kindA = z.object({ ev: z.literal('A'), id: z.string() });
  const kindB = z.object({ ev: z.literal('B') });
  const base = { input: z.object({}), output: z.object({}) };

  const changes = ctx.collect(
    { ...base, event: z.discriminatedUnion('ev', [kindA]) },
    { ...base, event: z.discriminatedUnion('ev', [kindA, kindB]) },
  );

  expect(changes).toStrictEqual([]);
});

test('it finds an event kind that a release removes', () => {
  const ctx = setupTest();
  const kindA = z.object({ ev: z.literal('A'), id: z.string() });
  const kindB = z.object({ ev: z.literal('B') });
  const base = { input: z.object({}), output: z.object({}) };

  const changes = ctx.collect(
    { ...base, event: z.discriminatedUnion('ev', [kindA, kindB]) },
    { ...base, event: z.discriminatedUnion('ev', [kindA]) },
  );

  expect(changes).toStrictEqual([
    {
      kind: 'breaking',
      method: 'event',
      path: '',
      message: 'answer: the union variant ev="B" is removed',
    },
  ]);
});

test('it finds a field that an event kind drops', () => {
  const ctx = setupTest();
  const base = { input: z.object({}), output: z.object({}) };
  const withID = z.object({ ev: z.literal('A'), id: z.string() });
  const without = z.object({ ev: z.literal('A') });

  const changes = ctx.collect(
    { ...base, event: z.discriminatedUnion('ev', [withID]) },
    { ...base, event: z.discriminatedUnion('ev', [without]) },
  );

  expect(changes).toStrictEqual([
    {
      kind: 'breaking',
      method: 'event',
      path: 'id',
      message: 'answer: the field is removed or renamed',
    },
  ]);
});

test('it skips the hello input of a release that did not hold the hello strict', () => {
  const ctx = setupTest();
  const base = { method: 'daemon.hello', output: z.object({}) };

  const changes = ctx.collect(
    { ...base, input: z.object({ client: z.string().optional() }) },
    {
      ...base,
      input: z.strictObject({ client: z.string().optional(), major: z.number().optional() }),
    },
  );

  expect(changes).toStrictEqual([]);
});

test('it checks the hello input of a release that held the hello strict', () => {
  const ctx = setupTest();
  const base = { method: 'daemon.hello', output: z.object({}) };

  const changes = ctx.collect(
    { ...base, input: z.strictObject({ client: z.string().optional() }) },
    {
      ...base,
      input: z.strictObject({ client: z.string().optional(), major: z.number().optional() }),
    },
  );

  expect(changes.map((change) => change.kind)).toStrictEqual(['new-input-field']);
});

test('it skips a schema that JSON Schema cannot hold', () => {
  const held = {
    procedures: { 'events.subscribe': { input: { type: 'object' }, output: null } },
    event: null,
  };

  expect(collectContractChanges(held, held)).toStrictEqual([]);
});
