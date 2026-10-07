import { expect, onTestFinished, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createStubBin } from './create-stub-bin';
import { createStubClaude } from './create-stub-claude';
import { setupTempDir } from './setup-temp-dir';
import { waitFor } from './wait-for';

/**
 * The stub in a fresh home, with a settings file whose `SessionStart` hook
 * command appends each payload it reads to `hooks.jsonl` as a line, as atc's
 * own settings file holds the reporter there. The atc command it gets
 * appends its arguments to `atc.log` and prints them, and the composer
 * prints that it ran.
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

  // A run that execs the composer needs a script that prints without a terminal.
  writeFileSync(join(tmp.dir, 'composer.js'), "console.log('COMPOSER_RAN');\n");

  // The tap and restart scenarios run atc, which here records its arguments.
  const atc = createStubBin(tmp.dir, 'atc', '#!/bin/sh\necho "$*" >> "$HOME/atc.log"\necho "$*"\n');

  const stub = createStubClaude(tmp.dir, {
    atc: [atc],
    composer: join(tmp.dir, 'composer.js'),
  });

  return { dir: tmp.dir, settings, stub, [Symbol.dispose]: tmp[Symbol.dispose] };
}

test('it reports a start and a permission prompt through the settings hook command', () => {
  using ctx = setupTest();

  Bun.spawnSync([ctx.stub, '--settings', ctx.settings], {
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
  using ctx = setupTest();

  const run = Bun.spawnSync([ctx.stub, '--settings', ctx.settings], {
    env: { ...process.env, HOME: ctx.dir, TERM: 'dumb', CLAUDE_CODE_ATC_TEST: 'parent' },
  });

  expect(run.stdout.toString()).toBe(
    `FAKE_CLAUDE_UP args: --settings ${ctx.settings}\nFAKE_CLAUDE_TERM:[dumb]\nFAKE_CLAUDE_PARENT:[parent]\n`,
  );
});

test('it echoes each input line once its reports are sent', () => {
  using ctx = setupTest();

  const run = Bun.spawnSync([ctx.stub, '--settings', ctx.settings], {
    env: { ...process.env, HOME: ctx.dir },
    stdin: Buffer.from('hello\nworld\n'),
  });

  expect(run.stdout.toString()).toEndWith('GOT:hello\nGOT:world\n');
});

test('it appends its atc session id to the starts log on every run', () => {
  using ctx = setupTest();

  for (const id of ['s-1', 's-2']) {
    Bun.spawnSync([ctx.stub, '--settings', ctx.settings], {
      env: { ...process.env, HOME: ctx.dir, ATC_SESSION_ID: id },
    });
  }

  expect(readFileSync(join(ctx.dir, 'fake-claude-starts.log'), 'utf8')).toBe('s-1\ns-2\n');
});

test('it reports the payloads of the events file after the permission prompt', () => {
  using ctx = setupTest();

  writeFileSync(
    join(ctx.dir, 'fake-claude-events.jsonl'),
    '{"hook_event_name":"Stop","session_id":"fake-1"}\n\n{"hook_event_name":"SessionEnd","session_id":"fake-1"}\n',
  );

  Bun.spawnSync([ctx.stub, '--settings', ctx.settings], { env: { ...process.env, HOME: ctx.dir } });

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
  using ctx = setupTest();

  writeFileSync(join(ctx.dir, 'fake-claude-exit'), '');

  const run = Bun.spawnSync([ctx.stub, '--settings', ctx.settings], {
    env: { ...process.env, HOME: ctx.dir },
    stdin: Buffer.from('hello\n'),
  });

  expect(run.stdout.toString()).not.toInclude('GOT:hello');
});

test('it reports its atc session id as the agent session when the home asks it to', () => {
  using ctx = setupTest();

  writeFileSync(join(ctx.dir, 'fake-claude-own-id'), '');

  Bun.spawnSync([ctx.stub, '--settings', ctx.settings], {
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
  using ctx = setupTest();

  writeFileSync(join(ctx.dir, 'fake-claude-dies-agent-a'), '');

  const run = Bun.spawnSync([ctx.stub, '--settings', ctx.settings, '--resume', 'agent-a'], {
    env: { ...process.env, HOME: ctx.dir },
    stdin: Buffer.from('hello\n'),
  });

  expect(run.exitCode).toBe(0);
  expect(run.stdout.toString()).not.toInclude('GOT:hello');
  expect(existsSync(join(ctx.dir, 'hooks.jsonl'))).toBeFalse();
});

test('it reports nothing and only echoes input while the home holds its start', () => {
  using ctx = setupTest();

  writeFileSync(join(ctx.dir, 'fake-claude-hold-start'), '');

  const run = Bun.spawnSync([ctx.stub, '--settings', ctx.settings], {
    env: { ...process.env, HOME: ctx.dir },
    stdin: Buffer.from('hello\n'),
  });

  expect(run.stdout.toString()).toEndWith('GOT:hello\n');
  expect(existsSync(join(ctx.dir, 'hooks.jsonl'))).toBeFalse();
});

test('it runs the composer in its place when the home asks for one', () => {
  using ctx = setupTest();

  writeFileSync(join(ctx.dir, 'fake-claude-composer'), '');

  const run = Bun.spawnSync([ctx.stub, '--settings', ctx.settings], {
    env: { ...process.env, HOME: ctx.dir },
  });

  expect(run.stdout.toString()).toEndWith('COMPOSER_RAN\n');
  expect(existsSync(join(ctx.dir, 'hooks.jsonl'))).toBeFalse();
});

test('it holds its reports at the gate until an input line arrives, removing the gate', async () => {
  using ctx = setupTest();

  writeFileSync(join(ctx.dir, 'fake-claude-gate'), '');

  const proc = Bun.spawn([ctx.stub, '--settings', ctx.settings], {
    env: { ...process.env, HOME: ctx.dir },
    stdin: 'pipe',
    stdout: 'ignore',
  });

  onTestFinished(() => {
    proc.kill();
  });

  await waitFor(() => {
    expect(existsSync(join(ctx.dir, 'fake-claude-gate'))).toBeFalse();
  });

  const heldReports = existsSync(join(ctx.dir, 'hooks.jsonl'));

  void proc.stdin.write('go\n');
  void proc.stdin.end();

  await proc.exited;

  expect(heldReports).toBeFalse();
  expect(readFileSync(join(ctx.dir, 'hooks.jsonl'), 'utf8')).toInclude('SessionStart');
});

test('it runs a daemon restart after its start once and removes the request', () => {
  using ctx = setupTest();

  writeFileSync(join(ctx.dir, 'fake-claude-restart'), '');

  Bun.spawnSync([ctx.stub, '--settings', ctx.settings], { env: { ...process.env, HOME: ctx.dir } });

  expect(readFileSync(join(ctx.dir, 'restart.out'), 'utf8')).toBe('daemon restart\n');
  expect(existsSync(join(ctx.dir, 'fake-claude-restart'))).toBeFalse();
});

test('it taps its own session into the tap log when the home asks it to', async () => {
  using ctx = setupTest();

  writeFileSync(join(ctx.dir, 'fake-claude-tap'), '');

  Bun.spawnSync([ctx.stub, '--settings', ctx.settings], {
    env: { ...process.env, HOME: ctx.dir, ATC_SESSION_ID: 's-tap' },
  });

  await waitFor(() => {
    expect(readFileSync(join(ctx.dir, 'tap.jsonl'), 'utf8')).toBe('tap --session s-tap\n');
  });
});
