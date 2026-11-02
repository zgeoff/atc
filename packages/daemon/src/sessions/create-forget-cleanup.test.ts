import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildStubLog, setupTempDir } from '@atc/test-utils';
import { toSessionID } from '@atcx/contract';
import { buildMockSession } from '../testing/build-mock-session';
import { createForgetCleanup } from './create-forget-cleanup';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-forget-cleanup-');
  const stateDir = join(temporaryDirectory.path, 'state');
  const log = buildStubLog();

  return {
    stateDir,
    log,
    cleanup: createForgetCleanup({ log: log.log, stateDir, settings: { enabled: true } }),
  };
}

test('it removes the state folder of a forgotten session', async () => {
  const ctx = setupTest();
  const session = buildMockSession();
  const folder = join(ctx.stateDir, 'sessions', session.id);

  mkdirSync(join(folder, 'scratch'), { recursive: true });
  writeFileSync(join(folder, 'scratch', 'draft.md'), '# plan\n');

  const workspace = await ctx.cleanup.removeSessionFolders(session, { harnessEnded: true });

  expect(workspace).toStrictEqual({ outcome: 'none' });
  expect(existsSync(folder)).toBeFalse();
  expect(ctx.log.lines).toBeEmpty();
});

test("it keeps and logs the state folder when atc could not confirm that the session's process exited", async () => {
  const ctx = setupTest();
  const session = buildMockSession();
  const folder = join(ctx.stateDir, 'sessions', session.id);

  mkdirSync(folder, { recursive: true });

  const workspace = await ctx.cleanup.removeSessionFolders(session, { harnessEnded: false });

  expect(workspace).toStrictEqual({ outcome: 'none' });
  expect(existsSync(folder)).toBeTrue();

  expect(ctx.log.lines).toStrictEqual([
    `atc: left the state folder of session ${session.id}: unchecked: atc could not confirm that the session's process exited`,
  ]);
});

test('it keeps the state folder when cleanup is off', async () => {
  const ctx = setupTest();
  const session = buildMockSession();
  const folder = join(ctx.stateDir, 'sessions', session.id);

  mkdirSync(folder, { recursive: true });

  const cleanup = createForgetCleanup({
    log: ctx.log.log,
    stateDir: ctx.stateDir,
    settings: { enabled: false },
  });

  const workspace = await cleanup.removeSessionFolders(session, { harnessEnded: true });

  expect(workspace).toStrictEqual({ outcome: 'none' });
  expect(existsSync(folder)).toBeTrue();
});

test('it logs and leaves a state folder whose session id would reach outside the sessions folder', async () => {
  const ctx = setupTest();
  const session = buildMockSession({ id: toSessionID('../records') });
  const records = join(ctx.stateDir, 'records');

  mkdirSync(records, { recursive: true });

  const workspace = await ctx.cleanup.removeSessionFolders(session, { harnessEnded: true });

  expect(workspace).toStrictEqual({ outcome: 'none' });
  expect(existsSync(records)).toBeTrue();

  expect(ctx.log.lines).toStrictEqual([
    `atc: left the state folder of session ../records, since its id names no folder of its own under ${join(ctx.stateDir, 'sessions')}`,
  ]);
});
