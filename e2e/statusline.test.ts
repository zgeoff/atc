import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolvePaths } from '@atc/config';
import { readSourceEntry, runCommand, setupTempDir } from '@atc/test-utils';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-statusline-');

  return { directory: temporaryDirectory.path };
}

test('it chains the user statusline and appends the fleet segment', async () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.directory, '.claude'), { recursive: true });

  writeFileSync(
    join(ctx.directory, '.claude', 'settings.json'),
    JSON.stringify({ statusLine: { type: 'command', command: 'echo CHAINED-SEGMENT' } }),
  );

  const paths = resolvePaths({ HOME: ctx.directory });

  mkdirSync(paths.stateDir, { recursive: true });

  writeFileSync(
    paths.statusFile,
    JSON.stringify({ needs_you: 2, running: 1, done: 0, exited: 0, urgent: 'auth-bug' }),
  );

  const subprocess = await runCommand([process.execPath, readSourceEntry('atc'), 'statusline'], {
    stdin: JSON.stringify({ session_id: 'sl-1' }),
    env: { ...process.env, HOME: ctx.directory, PATH: '/usr/sbin:/usr/bin:/bin' },
  });

  expect(subprocess.stdout).toBe(
    'CHAINED-SEGMENT \u001B[90m▏\u001B[0m \u001B[1;31m● 2 need you: auth-bug\u001B[0m \u001B[36m◐ 1\u001B[0m\n',
  );
});

test.each([
  { command: "echo SHOULD-NOT-RUN statusline --agent='claude'" },
  { command: "echo SHOULD-NOT-RUN statusline --agent 'claude'" },
  { command: 'echo SHOULD-NOT-RUN statusline' },
])('it never chains $command, which is its own injected command', async (row) => {
  const ctx = setupTest();

  mkdirSync(join(ctx.directory, '.claude'), { recursive: true });

  writeFileSync(
    join(ctx.directory, '.claude', 'settings.json'),
    JSON.stringify({ statusLine: { type: 'command', command: row.command } }),
  );

  const subprocess = await runCommand([process.execPath, readSourceEntry('atc'), 'statusline'], {
    stdin: JSON.stringify({ session_id: 'sl-1' }),
    env: { ...process.env, HOME: ctx.directory, PATH: '/usr/sbin:/usr/bin:/bin' },
  });

  expect(subprocess.stdout).not.toInclude('SHOULD-NOT-RUN');
});

test('it chains the user statusline from the Claude config folder CLAUDE_CONFIG_DIR sets', async () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.directory, '.claude'), { recursive: true });
  mkdirSync(join(ctx.directory, 'claude-config'), { recursive: true });

  writeFileSync(
    join(ctx.directory, '.claude', 'settings.json'),
    JSON.stringify({ statusLine: { type: 'command', command: 'echo HOME-SEGMENT' } }),
  );

  writeFileSync(
    join(ctx.directory, 'claude-config', 'settings.json'),
    JSON.stringify({ statusLine: { type: 'command', command: 'echo CONFIG-DIR-SEGMENT' } }),
  );

  const subprocess = await runCommand([process.execPath, readSourceEntry('atc'), 'statusline'], {
    stdin: JSON.stringify({ session_id: 'sl-2' }),
    env: {
      ...process.env,
      HOME: ctx.directory,
      PATH: '/usr/sbin:/usr/bin:/bin',
      CLAUDE_CONFIG_DIR: join(ctx.directory, 'claude-config'),
    },
  });

  expect(subprocess.stdout).toBe('CONFIG-DIR-SEGMENT\n');
});
