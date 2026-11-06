import { expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  createEnrollmentToken,
  createPasskey,
  openMCPAuth,
  readEnrollmentToken,
  readOwnerSessionViews,
  readPasskeyViews,
} from '@atc/mcp';
import { registerTestCleanup, setupTempDir } from '@atc/test-utils';
import invariant from 'tiny-invariant';
import { openMCPAuthDatabase } from './open-mcp-auth-database';
import { runPasskeys } from './passkeys';

// A temp directory that holds the authorization database the command
// opens, with the database opened a second time the way the server opens
// it, to arrange and read rows through.
async function setupTest() {
  const temporaryDirectory = setupTempDir('atc-passkeys-');
  const dbPath = join(temporaryDirectory.path, 'state', 'mcp-auth.db');

  await runPasskeys(
    { kind: 'list' },
    { dbPath, command: 'atc passkeys' },
    { print: () => {}, printError: () => {}, setExitCode: () => {}, now: () => 0 },
  );

  const store = await openMCPAuth({ dbPath, openDatabase: openMCPAuthDatabase, origin: null });

  registerTestCleanup(() => store.close());

  return { dbPath, store };
}

test('it prints an enrollment token the server accepts until it expires 15 minutes later', async () => {
  const ctx = await setupTest();

  const printed: string[] = [];

  await runPasskeys(
    { kind: 'enroll', reset: false },
    { dbPath: ctx.dbPath, command: 'atc passkeys' },
    {
      print: (line) => {
        printed.push(line);
      },
      printError: () => {},
      setExitCode: () => {},
      now: () => Date.UTC(2026, 9, 14, 12, 0, 0),
    },
  );

  const token = /^Enrollment token: (?<token>atc-enroll-[\w-]{43})$/u.exec(printed[0] ?? '')
    ?.groups?.['token'];

  expect(printed[1]).toBe(
    "It enrolls one passkey and expires at 2026-10-14T12:15:00.000Z. Open /enroll on the server's public URL in your browser and type it there.",
  );

  const found = await readEnrollmentToken(
    ctx.store.db,
    token ?? '',
    Date.UTC(2026, 9, 14, 12, 14, 59),
  );

  expect(found).toBeString();
});

test('it keeps the enrolled passkeys when it enrolls without reset', async () => {
  const ctx = await setupTest();

  await ctx.store.db
    .insertInto('atc_enrollment_token')
    .values({
      token_hash: 'hash-1',
      created_at: '2026-10-14T12:00:00.000Z',
      expires_at: '2999-01-01T00:00:00.000Z',
    })
    .execute();

  await createPasskey(ctx.store.db, {
    tokenHash: 'hash-1',
    id: 'cred-phone',
    publicKey: 'AQID',
    counter: 0,
    transports: ['internal'],
    now: Date.UTC(2026, 9, 14, 12, 0, 0),
  });

  await runPasskeys(
    { kind: 'enroll', reset: false },
    { dbPath: ctx.dbPath, command: 'atc passkeys' },
    { print: () => {}, printError: () => {}, setExitCode: () => {}, now: () => Date.now() },
  );

  const passkeys = await readPasskeyViews(ctx.store.db);

  expect(passkeys).toStrictEqual([
    { id: 'cred-phone', createdAt: '2026-10-14T12:00:00.000Z', lastUsedAt: null },
  ]);
});

test('it removes every passkey, earlier token, and browser sign-in on reset', async () => {
  const ctx = await setupTest();

  const printed: string[] = [];

  await ctx.store.db
    .insertInto('atc_enrollment_token')
    .values({
      token_hash: 'hash-1',
      created_at: '2026-10-14T12:00:00.000Z',
      expires_at: '2999-01-01T00:00:00.000Z',
    })
    .execute();

  const earlier = await createEnrollmentToken(ctx.store.db, Date.now());

  await createPasskey(ctx.store.db, {
    tokenHash: 'hash-1',
    id: 'cred-lost',
    publicKey: 'AQID',
    counter: 0,
    transports: ['internal'],
    now: Date.UTC(2026, 9, 14, 12, 0, 0),
  });

  await ctx.store.auth.api.signInOwner({ body: {} });

  const signedInBefore = await readOwnerSessionViews(ctx.store.db);

  invariant(signedInBefore.length === 1, 'the arrangement left no browser sign-in');

  await runPasskeys(
    { kind: 'enroll', reset: true },
    { dbPath: ctx.dbPath, command: 'atc passkeys' },
    {
      print: (line) => {
        printed.push(line);
      },
      printError: () => {},
      setExitCode: () => {},
      now: () => Date.now(),
    },
  );

  expect(printed[0]).toBe(
    'Removed every passkey and enrollment token and ended every browser sign-in. Grants stay.',
  );

  expect(printed[1]).toStartWith('Enrollment token: atc-enroll-');

  const passkeys = await readPasskeyViews(ctx.store.db);

  expect(passkeys).toBeEmpty();

  const sessions = await readOwnerSessionViews(ctx.store.db);

  expect(sessions).toBeEmpty();

  const earlierFound = await readEnrollmentToken(ctx.store.db, earlier.token, Date.now());

  expect(earlierFound).toBeNull();

  const token = /^Enrollment token: (?<token>atc-enroll-[\w-]{43})$/u.exec(printed[1] ?? '')
    ?.groups?.['token'];

  const found = await readEnrollmentToken(ctx.store.db, token ?? '', Date.now());

  expect(found).toBeString();
});

test('it lists each enrolled passkey with when it was enrolled and last used', async () => {
  const ctx = await setupTest();

  const printed: string[] = [];

  await ctx.store.db
    .insertInto('atc_passkey')
    .values([
      {
        id: 'cred-phone',
        public_key: 'AQID',
        counter: 0,
        transports: '[]',
        created_at: '2026-10-14T12:00:00.000Z',
        last_used_at: '2026-10-14T13:00:00.000Z',
      },
      {
        id: 'cred-laptop',
        public_key: 'AQID',
        counter: 0,
        transports: '[]',
        created_at: '2026-10-14T12:30:00.000Z',
        last_used_at: null,
      },
    ])
    .execute();

  await runPasskeys(
    { kind: 'list' },
    { dbPath: ctx.dbPath, command: 'atc passkeys' },
    {
      print: (line) => {
        printed.push(line);
      },
      printError: () => {},
      setExitCode: () => {},
      now: () => Date.now(),
    },
  );

  expect(printed).toStrictEqual([
    'cred-phone  enrolled 2026-10-14T12:00:00.000Z  last used 2026-10-14T13:00:00.000Z',
    'cred-laptop  enrolled 2026-10-14T12:30:00.000Z  last used never',
  ]);
});

test('it says how to enroll when no passkey is enrolled', async () => {
  const ctx = await setupTest();

  const printed: string[] = [];

  await runPasskeys(
    { kind: 'list' },
    { dbPath: ctx.dbPath, command: 'atc-gateway passkeys' },
    {
      print: (line) => {
        printed.push(line);
      },
      printError: () => {},
      setExitCode: () => {},
      now: () => Date.now(),
    },
  );

  expect(printed).toStrictEqual(['No passkeys. Enroll one with: atc-gateway passkeys enroll']);
});

test('it removes one passkey and keeps the others', async () => {
  const ctx = await setupTest();

  const printed: string[] = [];

  await ctx.store.db
    .insertInto('atc_passkey')
    .values([
      {
        id: 'cred-lost',
        public_key: 'AQID',
        counter: 0,
        transports: '[]',
        created_at: '2026-10-14T12:00:00.000Z',
        last_used_at: null,
      },
      {
        id: 'cred-kept',
        public_key: 'AQID',
        counter: 0,
        transports: '[]',
        created_at: '2026-10-14T12:30:00.000Z',
        last_used_at: null,
      },
    ])
    .execute();

  await runPasskeys(
    { kind: 'remove', id: 'cred-lost' },
    { dbPath: ctx.dbPath, command: 'atc passkeys' },
    {
      print: (line) => {
        printed.push(line);
      },
      printError: () => {},
      setExitCode: () => {},
      now: () => Date.now(),
    },
  );

  expect(printed).toStrictEqual(['Removed passkey cred-lost and ended every browser sign-in']);

  const passkeys = await readPasskeyViews(ctx.store.db);

  expect(passkeys).toStrictEqual([
    { id: 'cred-kept', createdAt: '2026-10-14T12:30:00.000Z', lastUsedAt: null },
  ]);
});

test('it sets exit code 1 when it removes a passkey that does not exist', async () => {
  const ctx = await setupTest();

  const errors: string[] = [];
  const codes: number[] = [];

  await runPasskeys(
    { kind: 'remove', id: 'cred-missing' },
    { dbPath: ctx.dbPath, command: 'atc passkeys' },
    {
      print: () => {},
      printError: (line) => {
        errors.push(line);
      },
      setExitCode: (code) => {
        codes.push(code);
      },
      now: () => Date.now(),
    },
  );

  expect(errors).toStrictEqual(["atc passkeys remove: no passkey has the ID 'cred-missing'"]);
  expect(codes).toStrictEqual([1]);
});
