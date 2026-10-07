import { expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createStubBin } from './create-stub-bin';
import { createStubGrok } from './create-stub-grok';
import { setupTempDir } from './setup-temp-dir';

/**
 * The stub in a fresh home. The atc command it reports through appends each
 * payload it reads and then its own arguments to `hooks.log`, one report per
 * line, and the composer prints that it ran.
 */
function setupTest() {
  const tmp = setupTempDir('atc-stub-grok-');

  // Every report goes through the atc command, recorded here.
  const atc = createStubBin(
    tmp.dir,
    'atc',
    '#!/bin/sh\n{ cat; echo " $*"; } >> "$HOME/hooks.log"\n',
  );

  // Every run that reports ends in the composer, which here only prints.
  writeFileSync(join(tmp.dir, 'composer.js'), "console.log('COMPOSER_RAN');\n");

  const stub = createStubGrok(tmp.dir, { atc: [atc], composer: join(tmp.dir, 'composer.js') });

  return { dir: tmp.dir, stub, [Symbol.dispose]: tmp[Symbol.dispose] };
}

test('it reports a start in its directory and a permission prompt as grok hooks', () => {
  using ctx = setupTest();

  Bun.spawnSync([ctx.stub], { cwd: ctx.dir, env: { ...process.env, HOME: ctx.dir } });

  expect(readFileSync(join(ctx.dir, 'hooks.log'), 'utf8')).toBe(
    `{"hookEventName":"session_start","sessionId":"fake-grok-1","cwd":"${ctx.dir}"} hook-report --agent grok\n` +
      '{"hookEventName":"notification","sessionId":"fake-grok-1","notificationType":"permission_prompt","message":"allow edit?"} hook-report --agent grok\n',
  );
});

test('it reports the events file in place of the permission prompt', () => {
  using ctx = setupTest();

  writeFileSync(
    join(ctx.dir, 'fake-grok-events.jsonl'),
    '{"hookEventName":"stop","sessionId":"fake-grok-1"}\n\n',
  );

  Bun.spawnSync([ctx.stub], { cwd: ctx.dir, env: { ...process.env, HOME: ctx.dir } });

  expect(readFileSync(join(ctx.dir, 'hooks.log'), 'utf8')).toBe(
    `{"hookEventName":"session_start","sessionId":"fake-grok-1","cwd":"${ctx.dir}"} hook-report --agent grok\n` +
      '{"hookEventName":"stop","sessionId":"fake-grok-1"} hook-report --agent grok\n',
  );
});

test('it prints its arguments, then that its hooks are done, then runs the composer', () => {
  using ctx = setupTest();

  const run = Bun.spawnSync([ctx.stub, '--no-leader'], {
    cwd: ctx.dir,
    env: { ...process.env, HOME: ctx.dir },
  });

  expect(run.stdout.toString()).toBe(
    'FAKE_GROK_UP args: --no-leader\nFAKE_GROK_HOOKS_DONE\nCOMPOSER_RAN\n',
  );
});

test('it reports nothing and only echoes input while the home holds its start', () => {
  using ctx = setupTest();

  writeFileSync(join(ctx.dir, 'fake-grok-hold-start'), '');

  const run = Bun.spawnSync([ctx.stub], {
    cwd: ctx.dir,
    env: { ...process.env, HOME: ctx.dir },
    stdin: Buffer.from('hello\n'),
  });

  expect(run.stdout.toString()).toBe('FAKE_GROK_UP args: \nGOT:hello\n');
  expect(existsSync(join(ctx.dir, 'hooks.log'))).toBeFalse();
});
