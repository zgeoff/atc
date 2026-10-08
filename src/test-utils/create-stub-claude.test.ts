import { expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildStubRecordingATC } from './build-stub-recording-atc';
import { createStubBin } from './create-stub-bin';
import { createStubClaude } from './create-stub-claude';
import { registerTestCleanup } from './register-test-cleanup';
import { setupTempDir } from './setup-temp-dir';
import { waitFor } from './wait-for';

/**
 * A fresh home with a settings file whose `SessionStart` hook command
 * appends each payload it reads to `hooks.jsonl` as a line, as atc's own
 * settings file holds the reporter there.
 */
function setupTest() {
  const tmp = setupTempDir('atc-stub-claude-');
  const settings = join(tmp.dir, 'settings.json');

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

  return { dir: tmp.dir, settings };
}

test('it reports a start and a permission prompt through the settings hook command', () => {
  const ctx = setupTest();

  const stub = createStubClaude(ctx.dir, {
    atc: ['false'],
    composer: join(ctx.dir, 'composer.js'),
  });

  Bun.spawnSync([stub, '--settings', ctx.settings], {
    env: { ...process.env, HOME: ctx.dir, ATC_SESSION_ID: 's-1' },
  });

  const hooks = readFileSync(join(ctx.dir, 'hooks.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line): unknown => JSON.parse(line));

  expect(hooks).toStrictEqual([
    {
      hook_event_name: 'SessionStart',
      session_id: 'fake-1',
      transcript_path: join(ctx.dir, 'fake-transcript.jsonl'),
    },
    { hook_event_name: 'Notification', session_id: 'fake-1', message: 'needs permission' },
  ]);
});

test('it prints its arguments, its TERM, and the parent-session variable it inherited', () => {
  const ctx = setupTest();

  const stub = createStubClaude(ctx.dir, {
    atc: ['false'],
    composer: join(ctx.dir, 'composer.js'),
  });

  const run = Bun.spawnSync([stub, '--settings', ctx.settings], {
    env: { ...process.env, HOME: ctx.dir, TERM: 'dumb', CLAUDE_CODE_ATC_TEST: 'parent' },
  });

  expect(run.stdout.toString()).toBe(
    `FAKE_CLAUDE_UP args: --settings ${ctx.settings}\nFAKE_CLAUDE_TERM:[dumb]\nFAKE_CLAUDE_PARENT:[parent]\n`,
  );
});

test('it echoes each input line once its reports are sent', () => {
  const ctx = setupTest();

  const stub = createStubClaude(ctx.dir, {
    atc: ['false'],
    composer: join(ctx.dir, 'composer.js'),
  });

  const run = Bun.spawnSync([stub, '--settings', ctx.settings], {
    env: { ...process.env, HOME: ctx.dir },
    stdin: Buffer.from('hello\nworld\n'),
  });

  expect(run.stdout.toString()).toEndWith('GOT:hello\nGOT:world\n');
});

test('it appends its atc session id to the starts log on every run', () => {
  const ctx = setupTest();

  const stub = createStubClaude(ctx.dir, {
    atc: ['false'],
    composer: join(ctx.dir, 'composer.js'),
  });

  for (const id of ['s-1', 's-2']) {
    Bun.spawnSync([stub, '--settings', ctx.settings], {
      env: { ...process.env, HOME: ctx.dir, ATC_SESSION_ID: id },
    });
  }

  expect(readFileSync(join(ctx.dir, 'fake-claude-starts.log'), 'utf8')).toBe('s-1\ns-2\n');
});

test('it reports the payloads of the events file after the permission prompt', () => {
  const ctx = setupTest();

  const stub = createStubClaude(ctx.dir, {
    atc: ['false'],
    composer: join(ctx.dir, 'composer.js'),
  });

  writeFileSync(
    join(ctx.dir, 'fake-claude-events.jsonl'),
    '{"hook_event_name":"Stop","session_id":"fake-1"}\n\n{"hook_event_name":"SessionEnd","session_id":"fake-1"}\n',
  );

  Bun.spawnSync([stub, '--settings', ctx.settings], { env: { ...process.env, HOME: ctx.dir } });

  const names = readFileSync(join(ctx.dir, 'hooks.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line): unknown => JSON.parse(line));

  expect(names).toStrictEqual([
    {
      hook_event_name: 'SessionStart',
      session_id: 'fake-1',
      transcript_path: join(ctx.dir, 'fake-transcript.jsonl'),
    },
    { hook_event_name: 'Notification', session_id: 'fake-1', message: 'needs permission' },
    { hook_event_name: 'Stop', session_id: 'fake-1' },
    { hook_event_name: 'SessionEnd', session_id: 'fake-1' },
  ]);
});

test('it exits after its reports without reading input when the home asks it to', () => {
  const ctx = setupTest();

  const stub = createStubClaude(ctx.dir, {
    atc: ['false'],
    composer: join(ctx.dir, 'composer.js'),
  });

  writeFileSync(join(ctx.dir, 'fake-claude-exit'), '');

  const run = Bun.spawnSync([stub, '--settings', ctx.settings], {
    env: { ...process.env, HOME: ctx.dir },
    stdin: Buffer.from('hello\n'),
  });

  const hooks = readFileSync(join(ctx.dir, 'hooks.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line): unknown => JSON.parse(line));

  expect(run.exitCode).toBe(0);
  expect(run.stdout.toString()).not.toInclude('GOT:hello');

  expect(hooks).toStrictEqual([
    {
      hook_event_name: 'SessionStart',
      session_id: 'fake-1',
      transcript_path: join(ctx.dir, 'fake-transcript.jsonl'),
    },
    { hook_event_name: 'Notification', session_id: 'fake-1', message: 'needs permission' },
  ]);
});

test('it reports its atc session id as the agent session when the home asks it to', () => {
  const ctx = setupTest();

  const stub = createStubClaude(ctx.dir, {
    atc: ['false'],
    composer: join(ctx.dir, 'composer.js'),
  });

  writeFileSync(join(ctx.dir, 'fake-claude-own-id'), '');

  Bun.spawnSync([stub, '--settings', ctx.settings], {
    env: { ...process.env, HOME: ctx.dir, ATC_SESSION_ID: 's-own' },
  });

  const hooks = readFileSync(join(ctx.dir, 'hooks.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line): unknown => JSON.parse(line));

  expect(hooks).toStrictEqual([
    {
      hook_event_name: 'SessionStart',
      session_id: 's-own',
      transcript_path: join(ctx.dir, 'fake-transcript.jsonl'),
    },
    { hook_event_name: 'Notification', session_id: 's-own', message: 'needs permission' },
  ]);
});

test('it exits at once without a report when it resumes an agent session the home marks dying', () => {
  const ctx = setupTest();

  const stub = createStubClaude(ctx.dir, {
    atc: ['false'],
    composer: join(ctx.dir, 'composer.js'),
  });

  writeFileSync(join(ctx.dir, 'fake-claude-dies-agent-a'), '');

  const run = Bun.spawnSync([stub, '--settings', ctx.settings, '--resume', 'agent-a'], {
    env: { ...process.env, HOME: ctx.dir },
    stdin: Buffer.from('hello\n'),
  });

  expect(run.exitCode).toBe(0);
  expect(run.stdout.toString()).not.toInclude('GOT:hello');
  expect(readdirSync(ctx.dir)).not.toContain('hooks.jsonl');
});

test('it reports nothing and only echoes input while the home holds its start', () => {
  const ctx = setupTest();

  const stub = createStubClaude(ctx.dir, {
    atc: ['false'],
    composer: join(ctx.dir, 'composer.js'),
  });

  writeFileSync(join(ctx.dir, 'fake-claude-hold-start'), '');

  const run = Bun.spawnSync([stub, '--settings', ctx.settings], {
    env: { ...process.env, HOME: ctx.dir },
    stdin: Buffer.from('hello\n'),
  });

  expect(run.stdout.toString()).toEndWith('GOT:hello\n');
  expect(readdirSync(ctx.dir)).not.toContain('hooks.jsonl');
});

test('it runs the composer in its place when the home asks for one', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.dir, 'composer.js'), "console.log('COMPOSER_RAN');\n");

  const stub = createStubClaude(ctx.dir, {
    atc: ['false'],
    composer: join(ctx.dir, 'composer.js'),
  });

  writeFileSync(join(ctx.dir, 'fake-claude-composer'), '');

  const run = Bun.spawnSync([stub, '--settings', ctx.settings], {
    env: { ...process.env, HOME: ctx.dir },
  });

  expect(run.stdout.toString()).toEndWith('COMPOSER_RAN\n');
  expect(readdirSync(ctx.dir)).not.toContain('hooks.jsonl');
});

test('it holds its reports at the gate until an input line arrives, removing the gate', async () => {
  const ctx = setupTest();

  const stub = createStubClaude(ctx.dir, {
    atc: ['false'],
    composer: join(ctx.dir, 'composer.js'),
  });

  writeFileSync(join(ctx.dir, 'fake-claude-gate'), '');

  const proc = Bun.spawn([stub, '--settings', ctx.settings], {
    env: { ...process.env, HOME: ctx.dir },
    stdin: 'pipe',
    stdout: 'ignore',
  });

  registerTestCleanup(() => {
    proc.kill();
  });

  await waitFor(() => {
    expect(readdirSync(ctx.dir)).not.toContain('fake-claude-gate');
  });

  const heldReports = existsSync(join(ctx.dir, 'hooks.jsonl'));

  void proc.stdin.write('go\n');
  void proc.stdin.end();

  await proc.exited;

  const hooks = readFileSync(join(ctx.dir, 'hooks.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line): unknown => JSON.parse(line));

  expect(heldReports).toBeFalse();

  expect(hooks).toStrictEqual([
    {
      hook_event_name: 'SessionStart',
      session_id: 'fake-1',
      transcript_path: join(ctx.dir, 'fake-transcript.jsonl'),
    },
    { hook_event_name: 'Notification', session_id: 'fake-1', message: 'needs permission' },
  ]);
});

test('it runs a daemon restart after its start once and removes the request', () => {
  const ctx = setupTest();

  // The atc the stub runs records each run on its own output, which the
  // stub sends to the file the scenario writes.
  const atc = createStubBin(ctx.dir, 'atc', buildStubRecordingATC('/dev/stdout'));

  const stub = createStubClaude(ctx.dir, {
    atc: [atc],
    composer: join(ctx.dir, 'composer.js'),
  });

  writeFileSync(join(ctx.dir, 'fake-claude-restart'), '');

  Bun.spawnSync([stub, '--settings', ctx.settings], {
    env: { ...process.env, HOME: ctx.dir, ATC_SESSION_ID: 's-1' },
  });

  expect(readFileSync(join(ctx.dir, 'restart.out'), 'utf8')).toBe(
    'args:daemon restart\nsession:s-1\nstdin:\n',
  );

  expect(readdirSync(ctx.dir)).not.toContain('fake-claude-restart');
});

test('it taps its own session into the tap log when the home asks it to', async () => {
  const ctx = setupTest();

  // The atc the stub runs records each run on its own output, which the
  // stub sends to the file the scenario writes.
  const atc = createStubBin(ctx.dir, 'atc', buildStubRecordingATC('/dev/stdout'));

  const stub = createStubClaude(ctx.dir, {
    atc: [atc],
    composer: join(ctx.dir, 'composer.js'),
  });

  writeFileSync(join(ctx.dir, 'fake-claude-tap'), '');

  Bun.spawnSync([stub, '--settings', ctx.settings], {
    env: { ...process.env, HOME: ctx.dir, ATC_SESSION_ID: 's-tap' },
  });

  await waitFor(() => {
    expect(readFileSync(join(ctx.dir, 'tap.jsonl'), 'utf8')).toBe(
      'args:tap --session s-tap\nsession:s-tap\nstdin:\n',
    );
  });
});
