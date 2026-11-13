import { expect, test } from 'bun:test';
import { join } from 'node:path';
import type { PasskeyID } from '@atc/mcp';
import { setupTempDir } from '@atc/test-utils';
import { toTagged } from '@zgeoff/std';
import { runPasskeys } from './passkeys';
import { openTestAuthAdmin } from './test-utils/open-test-auth-admin';

// A temp directory that holds the authorization database the command
// opens, with the database opened a second time the way the server opens
// it, to arrange and read rows through.
async function setupTest() {
  const temporaryDirectory = setupTempDir('atc-passkeys-');
  const dbPath = join(temporaryDirectory.path, 'state', 'mcp-auth.db');

  const opened = await openTestAuthAdmin(dbPath);

  return { dbPath, ...opened };
}

test('it prints an enrollment token and how to use it', async () => {
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
    },
  );

  expect(printed).toStrictEqual([
    expect.stringMatching(/^Enrollment token: enroll-[\w-]{43}$/u),
    "It enrolls one passkey. Open /enroll on the server's public URL in your browser and type it there.",
  ]);
});

test('it keeps the enrolled passkeys when it enrolls without reset', async () => {
  const ctx = await setupTest();

  ctx.seedPasskey({ id: 'cred-phone', createdAt: '2026-10-14T12:00:00.000Z' });

  await runPasskeys(
    { kind: 'enroll', reset: false },
    { dbPath: ctx.dbPath, command: 'atc passkeys' },
    { print: () => {}, printError: () => {}, setExitCode: () => {} },
  );

  expect(ctx.admin.passkeys.list()).resolves.toStrictEqual([
    {
      id: toTagged<PasskeyID>('cred-phone'),
      createdAt: '2026-10-14T12:00:00.000Z',
      lastUsedAt: null,
    },
  ]);
});

test('it removes every passkey and earlier enrollment token on reset', async () => {
  const ctx = await setupTest();

  const printed: string[] = [];

  ctx.seedPasskey({ id: 'cred-lost', createdAt: '2026-10-14T12:00:00.000Z' });

  await ctx.admin.passkeys.createEnrollmentToken();

  await runPasskeys(
    { kind: 'enroll', reset: true },
    { dbPath: ctx.dbPath, command: 'atc passkeys' },
    {
      print: (line) => {
        printed.push(line);
      },
      printError: () => {},
      setExitCode: () => {},
    },
  );

  expect(printed).toStrictEqual([
    'Removed every passkey and enrollment token and ended every browser sign-in. Grants stay.',
    expect.stringMatching(/^Enrollment token: enroll-/u),
    expect.toBeString(),
  ]);

  expect(ctx.admin.passkeys.list()).resolves.toBeEmpty();
  expect(ctx.countEnrollmentTokens()).toBe(1);
});

test('it lists each enrolled passkey with when it was enrolled and last used', async () => {
  const ctx = await setupTest();

  const printed: string[] = [];

  ctx.seedPasskey({
    id: 'cred-phone',
    createdAt: '2026-10-14T12:00:00.000Z',
    lastUsedAt: '2026-10-14T13:00:00.000Z',
  });

  ctx.seedPasskey({ id: 'cred-laptop', createdAt: '2026-10-14T12:30:00.000Z' });

  await runPasskeys(
    { kind: 'list' },
    { dbPath: ctx.dbPath, command: 'atc passkeys' },
    {
      print: (line) => {
        printed.push(line);
      },
      printError: () => {},
      setExitCode: () => {},
    },
  );

  expect(printed).toIncludeSameMembers([
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
    },
  );

  expect(printed).toStrictEqual(['No passkeys. Enroll one with: atc-gateway passkeys enroll']);
});

test('it removes one passkey and keeps the others', async () => {
  const ctx = await setupTest();

  const printed: string[] = [];

  ctx.seedPasskey({ id: 'cred-lost', createdAt: '2026-10-14T12:00:00.000Z' });
  ctx.seedPasskey({ id: 'cred-kept', createdAt: '2026-10-14T12:30:00.000Z' });

  await runPasskeys(
    { kind: 'remove', id: 'cred-lost' },
    { dbPath: ctx.dbPath, command: 'atc passkeys' },
    {
      print: (line) => {
        printed.push(line);
      },
      printError: () => {},
      setExitCode: () => {},
    },
  );

  expect(printed).toStrictEqual(['Removed passkey cred-lost and ended every browser sign-in']);

  expect(ctx.admin.passkeys.list()).resolves.toStrictEqual([
    {
      id: toTagged<PasskeyID>('cred-kept'),
      createdAt: '2026-10-14T12:30:00.000Z',
      lastUsedAt: null,
    },
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
    },
  );

  expect(errors).toStrictEqual(["atc passkeys remove: no passkey has the ID 'cred-missing'"]);
  expect(codes).toStrictEqual([1]);
});
