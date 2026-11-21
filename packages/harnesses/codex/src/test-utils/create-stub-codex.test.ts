import { expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildStubRecordingATC } from '@atc/core/test-utils/build-stub-recording-atc';
import { createStubBin } from '@zgeoff/testing/bin';
import { createTempDir } from '@zgeoff/testing/fs';
import { run } from '@zgeoff/testing/process';
import { createStubCodex } from './create-stub-codex';

function setupTest() {
  const temporaryDirectory = createTempDir('atc-stub-codex-');

  return { directory: temporaryDirectory.path };
}

test('it reports a start in its directory and a finished turn as codex hooks', async () => {
  const ctx = setupTest();

  const atc = createStubBin(ctx.directory, 'atc', {
    script: buildStubRecordingATC(join(ctx.directory, 'hooks.log')),
  }).path;

  writeFileSync(join(ctx.directory, 'composer.js'), "console.log('COMPOSER_RAN');\n");

  const stub = createStubCodex(ctx.directory, {
    atc: [atc],
    composer: join(ctx.directory, 'composer.js'),
  });

  await run([stub], {
    cwd: ctx.directory,
    env: { ...process.env, HOME: ctx.directory, ATC_SESSION_ID: 's-1' },
  });

  expect(readFileSync(join(ctx.directory, 'hooks.log'), 'utf8')).toBe(
    `args:hook-report --agent codex\nsession:s-1\nstdin:{"hook_event_name":"SessionStart","session_id":"fake-codex-1","transcript_path":"${ctx.directory}/fake-rollout.jsonl","cwd":"${ctx.directory}","source":"startup"}\n` +
      `args:hook-report --agent codex\nsession:s-1\nstdin:{"hook_event_name":"Stop","session_id":"fake-codex-1","transcript_path":"${ctx.directory}/fake-rollout.jsonl","last_assistant_message":"pong"}\n`,
  );
});

test('it prints its arguments, then runs the composer', async () => {
  const ctx = setupTest();

  const atc = createStubBin(ctx.directory, 'atc', {
    script: buildStubRecordingATC(join(ctx.directory, 'hooks.log')),
  }).path;

  writeFileSync(join(ctx.directory, 'composer.js'), "console.log('COMPOSER_RAN');\n");

  const stub = createStubCodex(ctx.directory, {
    atc: [atc],
    composer: join(ctx.directory, 'composer.js'),
  });

  const result = await run([stub, 'resume', 'fake-codex-1'], {
    cwd: ctx.directory,
    env: { ...process.env, HOME: ctx.directory, ATC_SESSION_ID: 's-1' },
  });

  expect(result.stdout).toBe('FAKE_CODEX_UP args: resume fake-codex-1\nCOMPOSER_RAN\n');
});
