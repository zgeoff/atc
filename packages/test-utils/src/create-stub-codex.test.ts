import { expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildStubRecordingATC } from './build-stub-recording-atc';
import { createStubBin } from './create-stub-bin';
import { createStubCodex } from './create-stub-codex';
import { runCommand } from './run-command';
import { setupTempDir } from './setup-temp-dir';

function setupTest() {
  const tmp = setupTempDir('atc-stub-codex-');

  return { dir: tmp.dir };
}

test('it reports a start in its directory and a finished turn as codex hooks', async () => {
  const ctx = setupTest();
  const atc = createStubBin(ctx.dir, 'atc', buildStubRecordingATC(join(ctx.dir, 'hooks.log')));

  writeFileSync(join(ctx.dir, 'composer.js'), "console.log('COMPOSER_RAN');\n");

  const stub = createStubCodex(ctx.dir, { atc: [atc], composer: join(ctx.dir, 'composer.js') });

  await runCommand([stub], {
    cwd: ctx.dir,
    env: { ...process.env, HOME: ctx.dir, ATC_SESSION_ID: 's-1' },
  });

  expect(readFileSync(join(ctx.dir, 'hooks.log'), 'utf8')).toBe(
    `args:hook-report --agent codex\nsession:s-1\nstdin:{"hook_event_name":"SessionStart","session_id":"fake-codex-1","transcript_path":"${ctx.dir}/fake-rollout.jsonl","cwd":"${ctx.dir}","source":"startup"}\n` +
      `args:hook-report --agent codex\nsession:s-1\nstdin:{"hook_event_name":"Stop","session_id":"fake-codex-1","transcript_path":"${ctx.dir}/fake-rollout.jsonl","last_assistant_message":"pong"}\n`,
  );
});

test('it prints its arguments, then runs the composer', async () => {
  const ctx = setupTest();
  const atc = createStubBin(ctx.dir, 'atc', buildStubRecordingATC(join(ctx.dir, 'hooks.log')));

  writeFileSync(join(ctx.dir, 'composer.js'), "console.log('COMPOSER_RAN');\n");

  const stub = createStubCodex(ctx.dir, { atc: [atc], composer: join(ctx.dir, 'composer.js') });

  const run = await runCommand([stub, 'resume', 'fake-codex-1'], {
    cwd: ctx.dir,
    env: { ...process.env, HOME: ctx.dir, ATC_SESSION_ID: 's-1' },
  });

  expect(run.stdout).toBe('FAKE_CODEX_UP args: resume fake-codex-1\nCOMPOSER_RAN\n');
});
