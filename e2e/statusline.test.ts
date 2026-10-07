import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '../src/test-utils/setup-temp-dir';

function setupTest() {
  return setupTempDir('atc-statusline-');
}

test('it chains the user statusline and appends the fleet segment', () => {
  using ctx = setupTest();

  mkdirSync(join(ctx.dir, '.claude'), { recursive: true });

  writeFileSync(
    join(ctx.dir, '.claude', 'settings.json'),
    JSON.stringify({ statusLine: { type: 'command', command: 'echo CHAINED-SEGMENT' } }),
  );

  mkdirSync(join(ctx.dir, '.local', 'state', 'atc'), { recursive: true });

  writeFileSync(
    join(ctx.dir, '.local', 'state', 'atc', 'status.json'),
    JSON.stringify({ needs_you: 2, running: 1, done: 0, exited: 0, urgent: 'auth-bug' }),
  );

  const proc = Bun.spawnSync(
    [process.execPath, join(import.meta.dir, '..', 'src', 'cli.ts'), 'statusline'],
    {
      stdin: new TextEncoder().encode(JSON.stringify({ session_id: 'sl-1' })),
      env: { ...process.env, HOME: ctx.dir, PATH: '/usr/sbin:/usr/bin:/bin' },
      stdout: 'pipe',
    },
  );

  expect(proc.stdout.toString()).toBe(
    'CHAINED-SEGMENT \u001B[90m▏\u001B[0m \u001B[1;31m● 2 need you: auth-bug\u001B[0m \u001B[36m◐ 1\u001B[0m\n',
  );
});

test('it chains the user statusline from the Claude config folder CLAUDE_CONFIG_DIR sets', () => {
  using ctx = setupTest();

  mkdirSync(join(ctx.dir, '.claude'), { recursive: true });
  mkdirSync(join(ctx.dir, 'claude-config'), { recursive: true });

  writeFileSync(
    join(ctx.dir, '.claude', 'settings.json'),
    JSON.stringify({ statusLine: { type: 'command', command: 'echo HOME-SEGMENT' } }),
  );

  writeFileSync(
    join(ctx.dir, 'claude-config', 'settings.json'),
    JSON.stringify({ statusLine: { type: 'command', command: 'echo CONFIG-DIR-SEGMENT' } }),
  );

  const proc = Bun.spawnSync(
    [process.execPath, join(import.meta.dir, '..', 'src', 'cli.ts'), 'statusline'],
    {
      stdin: new TextEncoder().encode(JSON.stringify({ session_id: 'sl-2' })),
      env: {
        ...process.env,
        HOME: ctx.dir,
        PATH: '/usr/sbin:/usr/bin:/bin',
        CLAUDE_CONFIG_DIR: join(ctx.dir, 'claude-config'),
      },
      stdout: 'pipe',
    },
  );

  expect(proc.stdout.toString()).toBe('CONFIG-DIR-SEGMENT\n');
});
