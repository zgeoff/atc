import { expect, test } from 'bun:test';
import { buildAgentEntrySchema } from './build-agent-entry-schema';

test('it reports one issue per problem, in the order the entry holds its fields', () => {
  const schema = buildAgentEntrySchema(
    { kind: 'grok', fields: [], defaultLabel: 'Grok' },
    { authProfiles: new Map(), entryID: 'grok', foreignFields: new Set(['env']) },
  );

  const result = schema.safeParse({ colour: 'red', bin: '', env: {} });

  expect(result.error?.issues.map((issue) => issue.message)).toStrictEqual([
    'unknown field colour',
    'bin must be a non-empty string',
    'env is not valid for kind grok',
  ]);
});

test("it runs the kind's own read once every field has the right type", () => {
  const schema = buildAgentEntrySchema(
    {
      kind: 'codex',
      fields: ['auth'],
      defaultLabel: 'Codex',
      read: (args) => ({ entry: { ...args.entry, label: 'read' }, warnings: ['kept'] }),
    },
    { authProfiles: new Map(), entryID: 'codex-b', foreignFields: new Set() },
  );

  expect(schema.safeParse({ kind: 'codex', auth: {} }).data).toStrictEqual({
    entry: {
      id: 'codex-b',
      kind: 'codex',
      label: 'read',
      mark: 'c',
      bin: 'codex',
      args: [],
      env: {},
    },
    warnings: ['kept'],
  });
});

test("it refuses an entry with every problem the kind's own read returns", () => {
  const schema = buildAgentEntrySchema(
    {
      kind: 'codex',
      fields: ['auth'],
      defaultLabel: 'Codex',
      read: () => ({ problems: ['auth is wrong', 'auth is still wrong'] }),
    },
    { authProfiles: new Map(), entryID: 'codex', foreignFields: new Set() },
  );

  const result = schema.safeParse({ auth: {} });

  expect(result.error?.issues.map((issue) => issue.message)).toStrictEqual([
    'auth is wrong',
    'auth is still wrong',
  ]);
});

test('it shows the label of its kind for the id that is the kind, and the id for any other', () => {
  const context = { authProfiles: new Map(), foreignFields: new Set<string>() };
  const spec = { kind: 'grok', fields: [], defaultLabel: 'Grok' } as const;
  const own = buildAgentEntrySchema(spec, { ...context, entryID: 'grok' }).safeParse({});
  const other = buildAgentEntrySchema(spec, { ...context, entryID: 'fast' }).safeParse({});

  expect(own.data?.entry.label).toBe('Grok');
  expect(other.data?.entry.label).toBe('fast');
});

test('it carries appServer onto the entry', () => {
  const schema = buildAgentEntrySchema(
    { kind: 'codex', fields: ['appServer'], defaultLabel: 'Codex' },
    { authProfiles: new Map(), entryID: 'codex', foreignFields: new Set() },
  );

  expect(schema.safeParse({ appServer: true }).data?.entry.appServer).toBe(true);
});

test('it refuses an appServer that is not true or false', () => {
  const schema = buildAgentEntrySchema(
    { kind: 'codex', fields: ['appServer'], defaultLabel: 'Codex' },
    { authProfiles: new Map(), entryID: 'codex', foreignFields: new Set() },
  );

  const result = schema.safeParse({ appServer: 'yes' });

  expect(result.error?.issues.map((issue) => issue.message)).toStrictEqual([
    'appServer must be true or false',
  ]);
});
