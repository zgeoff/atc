import { expect, onTestFinished, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeHookRunner } from './make-hook-runner';

function setupWorkDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'atc-hook-runner-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  return dir;
}

async function waitForFileContent(
  path: string,
  matches: (text: string) => boolean,
): Promise<string> {
  const deadline = Date.now() + 5000;

  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const text = readFileSync(path, 'utf8');

      if (matches(text)) {
        return text;
      }
    }

    await Bun.sleep(20);
  }

  throw new Error(`timed out waiting for hook output at ${path}`);
}

test('it runs a hook with the event JSON on stdin and the event name in the environment', async () => {
  const dir = setupWorkDir();
  const out = join(dir, 'out');

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
  const dir = setupWorkDir();

  const run = makeHookRunner({
    SessionAttached: [
      { command: `touch '${join(dir, 'exact')}'`, dir: '/w/repo' },
      { command: `touch '${join(dir, 'above')}'`, dir: '/w' },
    ],
  });

  run({ v: 3, ev: 'SessionAttached' }, { cwd: '/w/repo/sub', repoRoot: '/w/repo' });

  await waitForFileContent(join(dir, 'exact'), () => true);
  await waitForFileContent(join(dir, 'above'), () => true);
});

test('it skips a dir hook when the session path only shares a string prefix', async () => {
  const dir = setupWorkDir();

  const run = makeHookRunner({
    SessionAttached: [
      { command: `touch '${join(dir, 'trap')}'`, dir: '/w/b' },
      { command: `touch '${join(dir, 'control')}'` },
    ],
  });

  run({ v: 3, ev: 'SessionAttached' }, { cwd: '/w/bc', repoRoot: '/w/bc' });

  await waitForFileContent(join(dir, 'control'), () => true);

  // A skipped spawn leaves no signal; the settle gives a wrongly spawned
  // touch time to land before the absence assertion.
  await Bun.sleep(150);

  expect(existsSync(join(dir, 'trap'))).toBeFalse();
});

test('it skips dir hooks for an event that carries no session', async () => {
  const dir = setupWorkDir();

  const run = makeHookRunner({
    PermissionResolved: [
      { command: `touch '${join(dir, 'trap')}'`, dir: '/w' },
      { command: `touch '${join(dir, 'control')}'` },
    ],
  });

  run({ v: 3, ev: 'PermissionResolved', request: 'r1', decision: 'allow' }, null);

  await waitForFileContent(join(dir, 'control'), () => true);

  // A skipped spawn leaves no signal; the settle gives a wrongly spawned
  // touch time to land before the absence assertion.
  await Bun.sleep(150);

  expect(existsSync(join(dir, 'trap'))).toBeFalse();
});

test('it runs nothing for an event with no configured hooks', async () => {
  const dir = setupWorkDir();

  const run = makeHookRunner({
    SessionAttached: [{ command: `touch '${join(dir, 'trap')}'` }],
  });

  run({ v: 3, ev: 'SessionState', session: { id: 's1' } }, { cwd: '/w', repoRoot: '/w' });

  // A skipped spawn leaves no signal; the settle gives a wrongly spawned
  // touch time to land before the absence assertion.
  await Bun.sleep(150);

  expect(existsSync(join(dir, 'trap'))).toBeFalse();
});

test('it kills a hook that runs past its timeout', async () => {
  const dir = setupWorkDir();
  const out = join(dir, 'out');

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
