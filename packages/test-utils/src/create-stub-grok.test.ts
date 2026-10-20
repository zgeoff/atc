import { expect, test } from 'bun:test';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildStubRecordingATC } from './build-stub-recording-atc';
import { createStubBin } from './create-stub-bin';
import { createStubGrok } from './create-stub-grok';
import { runCommand } from './run-command';
import { setupTempDir } from './setup-temp-dir';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-stub-grok-');

  return { directory: temporaryDirectory.path };
}

test('it reports a start in its directory and a permission prompt as grok hooks', async () => {
  const ctx = setupTest();

  const atc = createStubBin(
    ctx.directory,
    'atc',
    buildStubRecordingATC(join(ctx.directory, 'hooks.log')),
  );

  writeFileSync(join(ctx.directory, 'composer.js'), "console.log('COMPOSER_RAN');\n");

  const stub = createStubGrok(ctx.directory, {
    atc: [atc],
    composer: join(ctx.directory, 'composer.js'),
  });

  await runCommand([stub], {
    cwd: ctx.directory,
    env: { ...process.env, HOME: ctx.directory, ATC_SESSION_ID: 's-1' },
  });

  expect(readFileSync(join(ctx.directory, 'hooks.log'), 'utf8')).toBe(
    `args:hook-report --agent grok\nsession:s-1\nstdin:{"hookEventName":"session_start","sessionId":"fake-grok-1","cwd":"${ctx.directory}"}\n` +
      'args:hook-report --agent grok\nsession:s-1\nstdin:{"hookEventName":"notification","sessionId":"fake-grok-1","notificationType":"permission_prompt","message":"allow edit?"}\n',
  );
});

test('it reports the events file in place of the permission prompt', async () => {
  const ctx = setupTest();

  const atc = createStubBin(
    ctx.directory,
    'atc',
    buildStubRecordingATC(join(ctx.directory, 'hooks.log')),
  );

  writeFileSync(join(ctx.directory, 'composer.js'), "console.log('COMPOSER_RAN');\n");

  const stub = createStubGrok(ctx.directory, {
    atc: [atc],
    composer: join(ctx.directory, 'composer.js'),
  });

  writeFileSync(
    join(ctx.directory, 'fake-grok-events.jsonl'),
    '{"hookEventName":"stop","sessionId":"fake-grok-1"}\n\n',
  );

  await runCommand([stub], {
    cwd: ctx.directory,
    env: { ...process.env, HOME: ctx.directory, ATC_SESSION_ID: 's-1' },
  });

  expect(readFileSync(join(ctx.directory, 'hooks.log'), 'utf8')).toBe(
    `args:hook-report --agent grok\nsession:s-1\nstdin:{"hookEventName":"session_start","sessionId":"fake-grok-1","cwd":"${ctx.directory}"}\n` +
      'args:hook-report --agent grok\nsession:s-1\nstdin:{"hookEventName":"stop","sessionId":"fake-grok-1"}\n',
  );
});

test('it prints its arguments, then that its hooks are done, then runs the composer', async () => {
  const ctx = setupTest();

  const atc = createStubBin(
    ctx.directory,
    'atc',
    buildStubRecordingATC(join(ctx.directory, 'hooks.log')),
  );

  writeFileSync(join(ctx.directory, 'composer.js'), "console.log('COMPOSER_RAN');\n");

  const stub = createStubGrok(ctx.directory, {
    atc: [atc],
    composer: join(ctx.directory, 'composer.js'),
  });

  const run = await runCommand([stub, '--no-leader'], {
    cwd: ctx.directory,
    env: { ...process.env, HOME: ctx.directory, ATC_SESSION_ID: 's-1' },
  });

  expect(run.stdout).toBe('FAKE_GROK_UP args: --no-leader\nFAKE_GROK_HOOKS_DONE\nCOMPOSER_RAN\n');
});

test('it reports nothing and only echoes input while the home holds its start', async () => {
  const ctx = setupTest();

  const atc = createStubBin(
    ctx.directory,
    'atc',
    buildStubRecordingATC(join(ctx.directory, 'hooks.log')),
  );

  writeFileSync(join(ctx.directory, 'composer.js'), "console.log('COMPOSER_RAN');\n");

  const stub = createStubGrok(ctx.directory, {
    atc: [atc],
    composer: join(ctx.directory, 'composer.js'),
  });

  writeFileSync(join(ctx.directory, 'fake-grok-hold-start'), '');

  const run = await runCommand([stub], {
    cwd: ctx.directory,
    env: { ...process.env, HOME: ctx.directory, ATC_SESSION_ID: 's-1' },
    stdin: Buffer.from('hello\n'),
  });

  expect(run.stdout).toBe('FAKE_GROK_UP args: \nGOT:hello\n');
  expect(readdirSync(ctx.directory)).not.toContain('hooks.log');
});
