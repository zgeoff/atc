import { expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createStubBin } from './create-stub-bin';
import { createStubCodex } from './create-stub-codex';
import { setupTempDir } from './setup-temp-dir';

/**
 * The stub in a fresh home. The atc command it reports through appends each
 * payload it reads and then its own arguments to `hooks.log`, one report per
 * line, and the composer prints that it ran.
 */
function setupTest() {
  const tmp = setupTempDir('atc-stub-codex-');

  // Every report goes through the atc command, recorded here.
  const atc = createStubBin(
    tmp.dir,
    'atc',
    '#!/bin/sh\n{ cat; echo " $*"; } >> "$HOME/hooks.log"\n',
  );

  // Every run ends in the composer, which here only prints.
  writeFileSync(join(tmp.dir, 'composer.js'), "console.log('COMPOSER_RAN');\n");

  const stub = createStubCodex(tmp.dir, { atc: [atc], composer: join(tmp.dir, 'composer.js') });

  return { dir: tmp.dir, stub, [Symbol.dispose]: tmp[Symbol.dispose] };
}

test('it reports a start in its directory and a finished turn as codex hooks', () => {
  using ctx = setupTest();

  Bun.spawnSync([ctx.stub], { cwd: ctx.dir, env: { ...process.env, HOME: ctx.dir } });

  expect(readFileSync(join(ctx.dir, 'hooks.log'), 'utf8')).toBe(
    `{"hook_event_name":"SessionStart","session_id":"fake-codex-1","transcript_path":"${ctx.dir}/fake-rollout.jsonl","cwd":"${ctx.dir}","source":"startup"} hook-report --agent codex\n` +
      `{"hook_event_name":"Stop","session_id":"fake-codex-1","transcript_path":"${ctx.dir}/fake-rollout.jsonl","last_assistant_message":"pong"} hook-report --agent codex\n`,
  );
});

test('it prints its arguments, then runs the composer', () => {
  using ctx = setupTest();

  const run = Bun.spawnSync([ctx.stub, 'resume', 'fake-codex-1'], {
    cwd: ctx.dir,
    env: { ...process.env, HOME: ctx.dir },
  });

  expect(run.stdout.toString()).toBe('FAKE_CODEX_UP args: resume fake-codex-1\nCOMPOSER_RAN\n');
});
