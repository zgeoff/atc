import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitForFileContent } from '../../test/wait-for-file-content';
import { makeHookRunner } from './make-hook-runner';

interface TestContext {
  readonly dir: string;
  [Symbol.asyncDispose]: () => Promise<void>;
}

function setupTest(): TestContext {
  const dir = mkdtempSync(join(tmpdir(), 'atc-hook-runner-'));

  return {
    dir,
    [Symbol.asyncDispose]: () => {
      rmSync(dir, { recursive: true, force: true });

      return Promise.resolve();
    },
  };
}

test('it runs a hook with the event JSON on stdin and the event name in the environment', async () => {
  await using ctx = setupTest();

  const out = join(ctx.dir, 'out');

  const run = makeHookRunner({
    SessionAttached: [{ command: `cat > '${out}'; printf '%s\n' "$ATC_EVENT" >> '${out}'` }],
  });

  run(
    { v: 3, ev: 'SessionAttached', session: { id: 's1', cwd: '/w' } },
    { cwd: '/w', repoRoot: '/w' },
  );

  const text = await waitForFileContent(out, (t) => t.endsWith('SessionAttached\n'));

  expect(text).toBe(
    `${JSON.stringify({ v: 3, ev: 'SessionAttached', session: { id: 's1', cwd: '/w' } })}\nSessionAttached\n`,
  );
});

test('it runs a dir hook when the session repo root or cwd sits at or under the dir', async () => {
  await using ctx = setupTest();

  const run = makeHookRunner({
    SessionAttached: [
      { command: `touch '${join(ctx.dir, 'exact')}'`, dir: '/w/repo' },
      { command: `touch '${join(ctx.dir, 'above')}'`, dir: '/w' },
    ],
  });

  run({ v: 3, ev: 'SessionAttached' }, { cwd: '/w/repo/sub', repoRoot: '/w/repo' });

  await waitForFileContent(join(ctx.dir, 'exact'));
  await waitForFileContent(join(ctx.dir, 'above'));
});

test('it skips a dir hook when the session path only shares a string prefix', async () => {
  await using ctx = setupTest();

  const run = makeHookRunner({
    SessionAttached: [
      { command: `touch '${join(ctx.dir, 'trap')}'`, dir: '/w/b' },
      { command: `touch '${join(ctx.dir, 'control')}'` },
    ],
  });

  run({ v: 3, ev: 'SessionAttached' }, { cwd: '/w/bc', repoRoot: '/w/bc' });

  await waitForFileContent(join(ctx.dir, 'control'));

  // A skipped spawn leaves no signal; the settle gives a wrongly spawned
  // touch time to land before the absence assertion.
  await Bun.sleep(150);

  expect(existsSync(join(ctx.dir, 'trap'))).toBeFalse();
});

test('it skips dir hooks for an event that carries no session', async () => {
  await using ctx = setupTest();

  const run = makeHookRunner({
    PermissionResolved: [
      { command: `touch '${join(ctx.dir, 'trap')}'`, dir: '/w' },
      { command: `touch '${join(ctx.dir, 'control')}'` },
    ],
  });

  run({ v: 3, ev: 'PermissionResolved', request: 'r1', decision: 'allow' }, null);

  await waitForFileContent(join(ctx.dir, 'control'));

  // A skipped spawn leaves no signal; the settle gives a wrongly spawned
  // touch time to land before the absence assertion.
  await Bun.sleep(150);

  expect(existsSync(join(ctx.dir, 'trap'))).toBeFalse();
});

test('it runs nothing for an event with no configured hooks', async () => {
  await using ctx = setupTest();

  const run = makeHookRunner({
    SessionAttached: [{ command: `touch '${join(ctx.dir, 'trap')}'` }],
  });

  run({ v: 3, ev: 'SessionState', session: { id: 's1' } }, { cwd: '/w', repoRoot: '/w' });

  // A skipped spawn leaves no signal; the settle gives a wrongly spawned
  // touch time to land before the absence assertion.
  await Bun.sleep(150);

  expect(existsSync(join(ctx.dir, 'trap'))).toBeFalse();
});

test('it kills a hook that runs past its timeout', async () => {
  await using ctx = setupTest();

  const out = join(ctx.dir, 'out');

  const run = makeHookRunner({
    SessionAttached: [
      { command: `printf start >> '${out}'; sleep 0.3; printf ' end' >> '${out}'`, timeout: 50 },
    ],
  });

  run({ v: 3, ev: 'SessionAttached' }, null);

  await waitForFileContent(out, (t) => t.includes('start'));

  // The kill leaves no observable signal; the wait outlives the script's
  // own sleep, so a survivor would have appended its end marker by now.
  await Bun.sleep(600);

  expect(readFileSync(out, 'utf8')).toBe('start');
});
