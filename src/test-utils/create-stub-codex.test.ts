import { expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createStubBin } from './create-stub-bin';
import { createStubCodex } from './create-stub-codex';
import { setupTempDir } from './setup-temp-dir';

function setupTest() {
  return setupTempDir('atc-stub-codex-');
}

test('it reports a start in its directory and a finished turn as codex hooks', () => {
  using ctx = setupTest();

  // The atc command the stub reports through appends each payload it reads
  // and then its own arguments to hooks.log, one report per line.
  const atc = createStubBin(
    ctx.dir,
    'atc',
    '#!/bin/sh\n{ cat; echo " $*"; } >> "$HOME/hooks.log"\n',
  );

  writeFileSync(join(ctx.dir, 'composer.js'), "console.log('COMPOSER_RAN');\n");

  const stub = createStubCodex(ctx.dir, { atc: [atc], composer: join(ctx.dir, 'composer.js') });

  Bun.spawnSync([stub], { cwd: ctx.dir, env: { ...process.env, HOME: ctx.dir } });

  expect(readFileSync(join(ctx.dir, 'hooks.log'), 'utf8')).toBe(
    `{"hook_event_name":"SessionStart","session_id":"fake-codex-1","transcript_path":"${ctx.dir}/fake-rollout.jsonl","cwd":"${ctx.dir}","source":"startup"} hook-report --agent codex\n` +
      `{"hook_event_name":"Stop","session_id":"fake-codex-1","transcript_path":"${ctx.dir}/fake-rollout.jsonl","last_assistant_message":"pong"} hook-report --agent codex\n`,
  );
});

test('it prints its arguments, then runs the composer', () => {
  using ctx = setupTest();

  // The atc command the stub reports through appends each payload it reads
  // and then its own arguments to hooks.log, one report per line.
  const atc = createStubBin(
    ctx.dir,
    'atc',
    '#!/bin/sh\n{ cat; echo " $*"; } >> "$HOME/hooks.log"\n',
  );

  writeFileSync(join(ctx.dir, 'composer.js'), "console.log('COMPOSER_RAN');\n");

  const stub = createStubCodex(ctx.dir, { atc: [atc], composer: join(ctx.dir, 'composer.js') });

  const run = Bun.spawnSync([stub, 'resume', 'fake-codex-1'], {
    cwd: ctx.dir,
    env: { ...process.env, HOME: ctx.dir },
  });

  expect(run.stdout.toString()).toBe('FAKE_CODEX_UP args: resume fake-codex-1\nCOMPOSER_RAN\n');
});
