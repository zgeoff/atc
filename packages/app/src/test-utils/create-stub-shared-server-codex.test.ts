import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildStubRecordingATC } from './build-stub-recording-atc';
import { createStubBin } from './create-stub-bin';
import { createStubSharedServerCodex } from './create-stub-shared-server-codex';
import { runCommand } from './run-command';

function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'atc-stub-shared-codex-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const atc = createStubBin(dir, 'atc', buildStubRecordingATC(join(dir, 'hooks.log')));

  // The stub finishes in the composer, so every start needs one to run.
  writeFileSync(join(dir, 'composer.js'), "console.log('COMPOSER_RAN');\n");

  const stub = createStubSharedServerCodex(dir, { atc: [atc], composer: join(dir, 'composer.js') });

  return { dir, stub };
}

test('it runs the hooks of a later start with the session of the first start', async () => {
  const ctx = setupTest();

  await runCommand([ctx.stub], { cwd: ctx.dir, env: { ...process.env, ATC_SESSION_ID: 's-1' } });
  await runCommand([ctx.stub], { cwd: ctx.dir, env: { ...process.env, ATC_SESSION_ID: 's-2' } });

  expect(readFileSync(join(ctx.dir, 'hooks.log'), 'utf8')).toBe(
    'args:hook-report --agent codex\nsession:s-1\nstdin:{"hook_event_name":"SessionStart","session_id":"fake-thread-s-1","source":"startup"}\n' +
      'args:hook-report --agent codex\nsession:s-1\nstdin:{"hook_event_name":"Stop","session_id":"fake-thread-s-1","last_assistant_message":"done fake-thread-s-1"}\n' +
      'args:hook-report --agent codex\nsession:s-1\nstdin:{"hook_event_name":"SessionStart","session_id":"fake-thread-s-2","source":"startup"}\n' +
      'args:hook-report --agent codex\nsession:s-1\nstdin:{"hook_event_name":"Stop","session_id":"fake-thread-s-2","last_assistant_message":"done fake-thread-s-2"}\n',
  );
});

test('it runs the hooks of a start with --no-daemon under its own session', async () => {
  const ctx = setupTest();

  await runCommand([ctx.stub], { cwd: ctx.dir, env: { ...process.env, ATC_SESSION_ID: 's-1' } });

  await runCommand([ctx.stub, '--no-daemon'], {
    cwd: ctx.dir,
    env: { ...process.env, ATC_SESSION_ID: 's-2' },
  });

  expect(readFileSync(join(ctx.dir, 'hooks.log'), 'utf8')).toEndWith(
    'args:hook-report --agent codex\nsession:s-2\nstdin:{"hook_event_name":"SessionStart","session_id":"fake-thread-s-2","source":"startup"}\n' +
      'args:hook-report --agent codex\nsession:s-2\nstdin:{"hook_event_name":"Stop","session_id":"fake-thread-s-2","last_assistant_message":"done fake-thread-s-2"}\n',
  );
});

test('it reports the thread it resumes', async () => {
  const ctx = setupTest();

  await runCommand([ctx.stub, '--no-daemon', 'resume', 't-9'], {
    cwd: ctx.dir,
    env: { ...process.env, ATC_SESSION_ID: 's-1' },
  });

  expect(readFileSync(join(ctx.dir, 'hooks.log'), 'utf8')).toBe(
    'args:hook-report --agent codex\nsession:s-1\nstdin:{"hook_event_name":"SessionStart","session_id":"t-9","source":"resume"}\n' +
      'args:hook-report --agent codex\nsession:s-1\nstdin:{"hook_event_name":"Stop","session_id":"t-9","last_assistant_message":"done t-9"}\n',
  );
});

test('it prints its arguments, then runs the composer', async () => {
  const ctx = setupTest();

  const run = await runCommand([ctx.stub, '--no-daemon', 'resume', 't-9'], {
    cwd: ctx.dir,
    env: { ...process.env, ATC_SESSION_ID: 's-1' },
  });

  expect(run.stdout).toBe('FAKE_CODEX_UP args: --no-daemon resume t-9\nCOMPOSER_RAN\n');
});
