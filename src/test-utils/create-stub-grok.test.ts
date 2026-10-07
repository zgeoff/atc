import { expect, test } from 'bun:test';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildStubRecordingATC } from './build-stub-recording-atc';
import { createStubBin } from './create-stub-bin';
import { createStubGrok } from './create-stub-grok';
import { setupTempDir } from './setup-temp-dir';

function setupTest() {
  return setupTempDir('atc-stub-grok-');
}

test('it reports a start in its directory and a permission prompt as grok hooks', () => {
  using ctx = setupTest();

  const atc = createStubBin(ctx.dir, 'atc', buildStubRecordingATC(join(ctx.dir, 'hooks.log')));

  writeFileSync(join(ctx.dir, 'composer.js'), "console.log('COMPOSER_RAN');\n");

  const stub = createStubGrok(ctx.dir, { atc: [atc], composer: join(ctx.dir, 'composer.js') });

  Bun.spawnSync([stub], {
    cwd: ctx.dir,
    env: { ...process.env, HOME: ctx.dir, ATC_SESSION_ID: 's-1' },
  });

  expect(readFileSync(join(ctx.dir, 'hooks.log'), 'utf8')).toBe(
    `args:hook-report --agent grok\nsession:s-1\nstdin:{"hookEventName":"session_start","sessionId":"fake-grok-1","cwd":"${ctx.dir}"}\n` +
      'args:hook-report --agent grok\nsession:s-1\nstdin:{"hookEventName":"notification","sessionId":"fake-grok-1","notificationType":"permission_prompt","message":"allow edit?"}\n',
  );
});

test('it reports the events file in place of the permission prompt', () => {
  using ctx = setupTest();

  const atc = createStubBin(ctx.dir, 'atc', buildStubRecordingATC(join(ctx.dir, 'hooks.log')));

  writeFileSync(join(ctx.dir, 'composer.js'), "console.log('COMPOSER_RAN');\n");

  const stub = createStubGrok(ctx.dir, { atc: [atc], composer: join(ctx.dir, 'composer.js') });

  writeFileSync(
    join(ctx.dir, 'fake-grok-events.jsonl'),
    '{"hookEventName":"stop","sessionId":"fake-grok-1"}\n\n',
  );

  Bun.spawnSync([stub], {
    cwd: ctx.dir,
    env: { ...process.env, HOME: ctx.dir, ATC_SESSION_ID: 's-1' },
  });

  expect(readFileSync(join(ctx.dir, 'hooks.log'), 'utf8')).toBe(
    `args:hook-report --agent grok\nsession:s-1\nstdin:{"hookEventName":"session_start","sessionId":"fake-grok-1","cwd":"${ctx.dir}"}\n` +
      'args:hook-report --agent grok\nsession:s-1\nstdin:{"hookEventName":"stop","sessionId":"fake-grok-1"}\n',
  );
});

test('it prints its arguments, then that its hooks are done, then runs the composer', () => {
  using ctx = setupTest();

  const atc = createStubBin(ctx.dir, 'atc', buildStubRecordingATC(join(ctx.dir, 'hooks.log')));

  writeFileSync(join(ctx.dir, 'composer.js'), "console.log('COMPOSER_RAN');\n");

  const stub = createStubGrok(ctx.dir, { atc: [atc], composer: join(ctx.dir, 'composer.js') });

  const run = Bun.spawnSync([stub, '--no-leader'], {
    cwd: ctx.dir,
    env: { ...process.env, HOME: ctx.dir, ATC_SESSION_ID: 's-1' },
  });

  expect(run.stdout.toString()).toBe(
    'FAKE_GROK_UP args: --no-leader\nFAKE_GROK_HOOKS_DONE\nCOMPOSER_RAN\n',
  );
});

test('it reports nothing and only echoes input while the home holds its start', () => {
  using ctx = setupTest();

  const atc = createStubBin(ctx.dir, 'atc', buildStubRecordingATC(join(ctx.dir, 'hooks.log')));

  writeFileSync(join(ctx.dir, 'composer.js'), "console.log('COMPOSER_RAN');\n");

  const stub = createStubGrok(ctx.dir, { atc: [atc], composer: join(ctx.dir, 'composer.js') });

  writeFileSync(join(ctx.dir, 'fake-grok-hold-start'), '');

  const run = Bun.spawnSync([stub], {
    cwd: ctx.dir,
    env: { ...process.env, HOME: ctx.dir, ATC_SESSION_ID: 's-1' },
    stdin: Buffer.from('hello\n'),
  });

  expect(run.stdout.toString()).toBe('FAKE_GROK_UP args: \nGOT:hello\n');
  expect(readdirSync(ctx.dir)).not.toContain('hooks.log');
});
