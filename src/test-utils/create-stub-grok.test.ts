import { expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createStubBin } from './create-stub-bin';
import { createStubGrok } from './create-stub-grok';
import { setupTempDir } from './setup-temp-dir';

function setupTest() {
  return setupTempDir('atc-stub-grok-');
}

test('it reports a start in its directory and a permission prompt as grok hooks', () => {
  using ctx = setupTest();

  // The atc command the stub reports through appends each payload it reads
  // and then its own arguments to hooks.log, one report per line.
  const atc = createStubBin(
    ctx.dir,
    'atc',
    '#!/bin/sh\n{ cat; echo " $*"; } >> "$HOME/hooks.log"\n',
  );

  writeFileSync(join(ctx.dir, 'composer.js'), "console.log('COMPOSER_RAN');\n");

  const stub = createStubGrok(ctx.dir, { atc: [atc], composer: join(ctx.dir, 'composer.js') });

  Bun.spawnSync([stub], { cwd: ctx.dir, env: { ...process.env, HOME: ctx.dir } });

  expect(readFileSync(join(ctx.dir, 'hooks.log'), 'utf8')).toBe(
    `{"hookEventName":"session_start","sessionId":"fake-grok-1","cwd":"${ctx.dir}"} hook-report --agent grok\n` +
      '{"hookEventName":"notification","sessionId":"fake-grok-1","notificationType":"permission_prompt","message":"allow edit?"} hook-report --agent grok\n',
  );
});

test('it reports the events file in place of the permission prompt', () => {
  using ctx = setupTest();

  // The atc command the stub reports through appends each payload it reads
  // and then its own arguments to hooks.log, one report per line.
  const atc = createStubBin(
    ctx.dir,
    'atc',
    '#!/bin/sh\n{ cat; echo " $*"; } >> "$HOME/hooks.log"\n',
  );

  writeFileSync(join(ctx.dir, 'composer.js'), "console.log('COMPOSER_RAN');\n");

  const stub = createStubGrok(ctx.dir, { atc: [atc], composer: join(ctx.dir, 'composer.js') });

  writeFileSync(
    join(ctx.dir, 'fake-grok-events.jsonl'),
    '{"hookEventName":"stop","sessionId":"fake-grok-1"}\n\n',
  );

  Bun.spawnSync([stub], { cwd: ctx.dir, env: { ...process.env, HOME: ctx.dir } });

  expect(readFileSync(join(ctx.dir, 'hooks.log'), 'utf8')).toBe(
    `{"hookEventName":"session_start","sessionId":"fake-grok-1","cwd":"${ctx.dir}"} hook-report --agent grok\n` +
      '{"hookEventName":"stop","sessionId":"fake-grok-1"} hook-report --agent grok\n',
  );
});

test('it prints its arguments, then that its hooks are done, then runs the composer', () => {
  using ctx = setupTest();

  // The atc command the stub reports through appends each payload it reads
  // and then its own arguments to hooks.log, one report per line.
  const atc = createStubBin(
    ctx.dir,
    'atc',
    '#!/bin/sh\n{ cat; echo " $*"; } >> "$HOME/hooks.log"\n',
  );

  writeFileSync(join(ctx.dir, 'composer.js'), "console.log('COMPOSER_RAN');\n");

  const stub = createStubGrok(ctx.dir, { atc: [atc], composer: join(ctx.dir, 'composer.js') });

  const run = Bun.spawnSync([stub, '--no-leader'], {
    cwd: ctx.dir,
    env: { ...process.env, HOME: ctx.dir },
  });

  expect(run.stdout.toString()).toBe(
    'FAKE_GROK_UP args: --no-leader\nFAKE_GROK_HOOKS_DONE\nCOMPOSER_RAN\n',
  );
});

test('it reports nothing and only echoes input while the home holds its start', () => {
  using ctx = setupTest();

  // The atc command the stub reports through appends each payload it reads
  // and then its own arguments to hooks.log, one report per line.
  const atc = createStubBin(
    ctx.dir,
    'atc',
    '#!/bin/sh\n{ cat; echo " $*"; } >> "$HOME/hooks.log"\n',
  );

  writeFileSync(join(ctx.dir, 'composer.js'), "console.log('COMPOSER_RAN');\n");

  const stub = createStubGrok(ctx.dir, { atc: [atc], composer: join(ctx.dir, 'composer.js') });

  writeFileSync(join(ctx.dir, 'fake-grok-hold-start'), '');

  const run = Bun.spawnSync([stub], {
    cwd: ctx.dir,
    env: { ...process.env, HOME: ctx.dir },
    stdin: Buffer.from('hello\n'),
  });

  expect(run.stdout.toString()).toBe('FAKE_GROK_UP args: \nGOT:hello\n');
  expect(existsSync(join(ctx.dir, 'hooks.log'))).toBeFalse();
});
