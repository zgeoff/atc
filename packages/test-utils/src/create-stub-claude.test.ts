import { expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildStubRecordingATC } from './build-stub-recording-atc';
import { createStubBin } from './create-stub-bin';
import { createStubClaude } from './create-stub-claude';
import { registerTestCleanup } from './register-test-cleanup';
import { runCommand } from './run-command';
import { setupTempDir } from './setup-temp-dir';
import { waitFor } from './wait-for';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-stub-claude-');
  const settings = join(temporaryDirectory.path, 'settings.json');

  // Every run reads the hook command from the settings file it is given.
  writeFileSync(
    settings,
    JSON.stringify({
      hooks: {
        SessionStart: [
          { hooks: [{ type: 'command', command: '{ cat; echo; } >> "$HOME/hooks.jsonl"' }] },
        ],
      },
    }),
  );

  return { directory: temporaryDirectory.path, settings };
}

test('it reports a start and a permission prompt through the settings hook command', async () => {
  const ctx = setupTest();

  const stub = createStubClaude(ctx.directory, {
    atc: ['false'],
    composer: join(ctx.directory, 'composer.js'),
  });

  await runCommand([stub, '--settings', ctx.settings], {
    env: { ...process.env, HOME: ctx.directory, ATC_SESSION_ID: 's-1' },
  });

  const hooks = readFileSync(join(ctx.directory, 'hooks.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line): unknown => JSON.parse(line));

  expect(hooks).toStrictEqual([
    {
      hook_event_name: 'SessionStart',
      session_id: 'fake-1',
      transcript_path: join(ctx.directory, 'fake-transcript.jsonl'),
    },
    { hook_event_name: 'Notification', session_id: 'fake-1', message: 'needs permission' },
  ]);
});

test('it prints its arguments, its TERM, and the parent-session variable it inherited', async () => {
  const ctx = setupTest();

  const stub = createStubClaude(ctx.directory, {
    atc: ['false'],
    composer: join(ctx.directory, 'composer.js'),
  });

  const run = await runCommand([stub, '--settings', ctx.settings], {
    env: { ...process.env, HOME: ctx.directory, TERM: 'dumb', CLAUDE_CODE_ATC_TEST: 'parent' },
  });

  expect(run.stdout).toBe(
    `FAKE_CLAUDE_UP args: --settings ${ctx.settings}\nFAKE_CLAUDE_TERM:[dumb]\nFAKE_CLAUDE_PARENT:[parent]\n`,
  );
});

test('it echoes each input line once its reports are sent', async () => {
  const ctx = setupTest();

  const stub = createStubClaude(ctx.directory, {
    atc: ['false'],
    composer: join(ctx.directory, 'composer.js'),
  });

  const run = await runCommand([stub, '--settings', ctx.settings], {
    env: { ...process.env, HOME: ctx.directory },
    stdin: Buffer.from('hello\nworld\n'),
  });

  expect(run.stdout).toEndWith('GOT:hello\nGOT:world\n');
});

test('it appends its atc session id to the starts log on every run', async () => {
  const ctx = setupTest();

  const stub = createStubClaude(ctx.directory, {
    atc: ['false'],
    composer: join(ctx.directory, 'composer.js'),
  });

  for (const id of ['s-1', 's-2']) {
    await runCommand([stub, '--settings', ctx.settings], {
      env: { ...process.env, HOME: ctx.directory, ATC_SESSION_ID: id },
    });
  }

  expect(readFileSync(join(ctx.directory, 'fake-claude-starts.log'), 'utf8')).toBe('s-1\ns-2\n');
});

test('it reports the payloads of the events file after the permission prompt', async () => {
  const ctx = setupTest();

  const stub = createStubClaude(ctx.directory, {
    atc: ['false'],
    composer: join(ctx.directory, 'composer.js'),
  });

  writeFileSync(
    join(ctx.directory, 'fake-claude-events.jsonl'),
    '{"hook_event_name":"Stop","session_id":"fake-1"}\n\n{"hook_event_name":"SessionEnd","session_id":"fake-1"}\n',
  );

  await runCommand([stub, '--settings', ctx.settings], {
    env: { ...process.env, HOME: ctx.directory },
  });

  const names = readFileSync(join(ctx.directory, 'hooks.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line): unknown => JSON.parse(line));

  expect(names).toStrictEqual([
    {
      hook_event_name: 'SessionStart',
      session_id: 'fake-1',
      transcript_path: join(ctx.directory, 'fake-transcript.jsonl'),
    },
    { hook_event_name: 'Notification', session_id: 'fake-1', message: 'needs permission' },
    { hook_event_name: 'Stop', session_id: 'fake-1' },
    { hook_event_name: 'SessionEnd', session_id: 'fake-1' },
  ]);
});

test('it exits after its reports without reading input when the home asks it to', async () => {
  const ctx = setupTest();

  const stub = createStubClaude(ctx.directory, {
    atc: ['false'],
    composer: join(ctx.directory, 'composer.js'),
  });

  writeFileSync(join(ctx.directory, 'fake-claude-exit'), '');

  const run = await runCommand([stub, '--settings', ctx.settings], {
    env: { ...process.env, HOME: ctx.directory },
    stdin: Buffer.from('hello\n'),
  });

  const hooks = readFileSync(join(ctx.directory, 'hooks.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line): unknown => JSON.parse(line));

  expect(run.exitCode).toBe(0);
  expect(run.stdout).not.toInclude('GOT:hello');

  expect(hooks).toStrictEqual([
    {
      hook_event_name: 'SessionStart',
      session_id: 'fake-1',
      transcript_path: join(ctx.directory, 'fake-transcript.jsonl'),
    },
    { hook_event_name: 'Notification', session_id: 'fake-1', message: 'needs permission' },
  ]);
});

test('it runs the composer after its reports when the home asks for one last', async () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.directory, 'composer.js'), "console.log('COMPOSER_RAN');\n");

  const stub = createStubClaude(ctx.directory, {
    atc: ['false'],
    composer: join(ctx.directory, 'composer.js'),
  });

  writeFileSync(join(ctx.directory, 'fake-claude-composer-last'), '');

  const run = await runCommand([stub, '--settings', ctx.settings], {
    env: { ...process.env, HOME: ctx.directory },
    stdin: Buffer.from('hello\n'),
  });

  const hooks = readFileSync(join(ctx.directory, 'hooks.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line): unknown => JSON.parse(line));

  expect(run.stdout).toEndWith('COMPOSER_RAN\n');
  expect(run.stdout).not.toInclude('GOT:hello');

  expect(hooks).toStrictEqual([
    {
      hook_event_name: 'SessionStart',
      session_id: 'fake-1',
      transcript_path: join(ctx.directory, 'fake-transcript.jsonl'),
    },
    { hook_event_name: 'Notification', session_id: 'fake-1', message: 'needs permission' },
  ]);
});

test('it reports its atc session id as the agent session when the home asks it to', async () => {
  const ctx = setupTest();

  const stub = createStubClaude(ctx.directory, {
    atc: ['false'],
    composer: join(ctx.directory, 'composer.js'),
  });

  writeFileSync(join(ctx.directory, 'fake-claude-own-id'), '');

  await runCommand([stub, '--settings', ctx.settings], {
    env: { ...process.env, HOME: ctx.directory, ATC_SESSION_ID: 's-own' },
  });

  const hooks = readFileSync(join(ctx.directory, 'hooks.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line): unknown => JSON.parse(line));

  expect(hooks).toStrictEqual([
    {
      hook_event_name: 'SessionStart',
      session_id: 's-own',
      transcript_path: join(ctx.directory, 'fake-transcript.jsonl'),
    },
    { hook_event_name: 'Notification', session_id: 's-own', message: 'needs permission' },
  ]);
});

test('it exits at once without a report when it resumes an agent session the home marks dying', async () => {
  const ctx = setupTest();

  const stub = createStubClaude(ctx.directory, {
    atc: ['false'],
    composer: join(ctx.directory, 'composer.js'),
  });

  writeFileSync(join(ctx.directory, 'fake-claude-dies-agent-a'), '');

  const run = await runCommand([stub, '--settings', ctx.settings, '--resume', 'agent-a'], {
    env: { ...process.env, HOME: ctx.directory },
    stdin: Buffer.from('hello\n'),
  });

  expect(run.exitCode).toBe(0);
  expect(run.stdout).not.toInclude('GOT:hello');
  expect(readdirSync(ctx.directory)).not.toContain('hooks.jsonl');
});

test('it reports nothing and only echoes input while the home holds its start', async () => {
  const ctx = setupTest();

  const stub = createStubClaude(ctx.directory, {
    atc: ['false'],
    composer: join(ctx.directory, 'composer.js'),
  });

  writeFileSync(join(ctx.directory, 'fake-claude-hold-start'), '');

  const run = await runCommand([stub, '--settings', ctx.settings], {
    env: { ...process.env, HOME: ctx.directory },
    stdin: Buffer.from('hello\n'),
  });

  expect(run.stdout).toEndWith('GOT:hello\n');
  expect(readdirSync(ctx.directory)).not.toContain('hooks.jsonl');
});

test('it runs the composer in its place when the home asks for one', async () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.directory, 'composer.js'), "console.log('COMPOSER_RAN');\n");

  const stub = createStubClaude(ctx.directory, {
    atc: ['false'],
    composer: join(ctx.directory, 'composer.js'),
  });

  writeFileSync(join(ctx.directory, 'fake-claude-composer'), '');

  const run = await runCommand([stub, '--settings', ctx.settings], {
    env: { ...process.env, HOME: ctx.directory },
  });

  expect(run.stdout).toEndWith('COMPOSER_RAN\n');
  expect(readdirSync(ctx.directory)).not.toContain('hooks.jsonl');
});

test('it holds its reports at the gate until an input line arrives, removing the gate', async () => {
  const ctx = setupTest();

  const stub = createStubClaude(ctx.directory, {
    atc: ['false'],
    composer: join(ctx.directory, 'composer.js'),
  });

  writeFileSync(join(ctx.directory, 'fake-claude-gate'), '');

  const subprocess = Bun.spawn([stub, '--settings', ctx.settings], {
    env: { ...process.env, HOME: ctx.directory },
    stdin: 'pipe',
    stdout: 'ignore',
  });

  registerTestCleanup(() => {
    subprocess.kill();
  });

  await waitFor(() => {
    expect(readdirSync(ctx.directory)).not.toContain('fake-claude-gate');
  });

  const heldReports = existsSync(join(ctx.directory, 'hooks.jsonl'));

  void subprocess.stdin.write('go\n');
  void subprocess.stdin.end();

  await subprocess.exited;

  const hooks = readFileSync(join(ctx.directory, 'hooks.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line): unknown => JSON.parse(line));

  expect(heldReports).toBeFalse();

  expect(hooks).toStrictEqual([
    {
      hook_event_name: 'SessionStart',
      session_id: 'fake-1',
      transcript_path: join(ctx.directory, 'fake-transcript.jsonl'),
    },
    { hook_event_name: 'Notification', session_id: 'fake-1', message: 'needs permission' },
  ]);
});

test('it runs a daemon restart after its start once and removes the request', async () => {
  const ctx = setupTest();

  // The atc the stub runs records each run on its own output, which the
  // stub sends to the file the scenario writes.
  const atc = createStubBin(ctx.directory, 'atc', buildStubRecordingATC('/dev/stdout'));

  const stub = createStubClaude(ctx.directory, {
    atc: [atc],
    composer: join(ctx.directory, 'composer.js'),
  });

  writeFileSync(join(ctx.directory, 'fake-claude-restart'), '');

  await runCommand([stub, '--settings', ctx.settings], {
    env: { ...process.env, HOME: ctx.directory, ATC_SESSION_ID: 's-1' },
  });

  expect(readFileSync(join(ctx.directory, 'restart.out'), 'utf8')).toBe(
    'args:daemon restart\nsession:s-1\nstdin:\n',
  );

  expect(readdirSync(ctx.directory)).not.toContain('fake-claude-restart');
});

test('it taps its own session into the tap log when the home asks it to', async () => {
  const ctx = setupTest();

  // The atc the stub runs records each run on its own output, which the
  // stub sends to the file the scenario writes.
  const atc = createStubBin(ctx.directory, 'atc', buildStubRecordingATC('/dev/stdout'));

  const stub = createStubClaude(ctx.directory, {
    atc: [atc],
    composer: join(ctx.directory, 'composer.js'),
  });

  writeFileSync(join(ctx.directory, 'fake-claude-tap'), '');

  await runCommand([stub, '--settings', ctx.settings], {
    env: { ...process.env, HOME: ctx.directory, ATC_SESSION_ID: 's-tap' },
  });

  await waitFor(() => {
    expect(readFileSync(join(ctx.directory, 'tap.jsonl'), 'utf8')).toBe(
      'args:tap --session s-tap\nsession:s-tap\nstdin:\n',
    );
  });
});
