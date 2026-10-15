import { expect, test } from 'bun:test';
import { toAgentSessionID, toSessionID } from '@atc/core';
import { updateEnv } from '@atc/test-utils';
import { buildClaudeQueryOptions } from './build-claude-query-options';

test('it runs a session turn in its directory, resumed, under the auto permission mode, with its model, effort, and mod', () => {
  const options = buildClaudeQueryOptions(
    {
      claudeBin: 'claude',
      cwd: '/work/repo',
      prompt: 'keep going',
      resume: toAgentSessionID('sess-123'),
      permissionMode: 'auto',
      sessionID: toSessionID('s-1'),
      reporterSocket: '/run/atc/atc.sock',
      pluginDir: '/state/atc-bridge',
      model: 'opus',
      effort: 'xhigh',
    },
    false,
  );

  const { env, ...rest } = options;

  expect(rest).toStrictEqual({
    cwd: '/work/repo',
    resume: 'sess-123',
    permissionMode: 'auto',
    model: 'opus',
    effort: 'xhigh',
  });

  expect(env).toMatchObject({
    CLAUDE_CODE_PLUGIN_DIRS: '/state/atc-bridge',
    ATC_SESSION_ID: 's-1',
    ATC_SOCKET: '/run/atc/atc.sock',
  });
});

test.each(['default', 'acceptEdits', 'bypassPermissions', 'plan', 'auto', 'dontAsk'])(
  'it passes the %s permission mode to the SDK as given',
  (mode) => {
    const options = buildClaudeQueryOptions(
      {
        claudeBin: 'claude',
        cwd: '/tmp',
        prompt: 'go',
        reporterSocket: '/run/atc/atc.sock',
        permissionMode: mode,
      },
      false,
    );

    expect(options.permissionMode).toBe(mode);
  },
);

test('it leaves out a permission mode the SDK does not accept', () => {
  const options = buildClaudeQueryOptions(
    {
      claudeBin: 'claude',
      cwd: '/tmp',
      prompt: 'go',
      reporterSocket: '/run/atc/atc.sock',
      permissionMode: 'yolo',
    },
    false,
  );

  expect(options).not.toContainKey('permissionMode');
});

test('it leaves the permission mode to the SDK when the turn names none', () => {
  const options = buildClaudeQueryOptions(
    { claudeBin: 'claude', cwd: '/tmp', prompt: 'go', reporterSocket: '/run/atc/atc.sock' },
    false,
  );

  expect(options).not.toContainKey('permissionMode');
});

test('it leaves out an effort the SDK does not accept', () => {
  const options = buildClaudeQueryOptions(
    {
      claudeBin: 'claude',
      cwd: '/tmp',
      prompt: 'go',
      reporterSocket: '/run/atc/atc.sock',
      effort: 'turbo',
    },
    false,
  );

  expect(options).not.toContainKey('effort');
});

test('it starts the CLI with the settings file a turn carries', () => {
  const options = buildClaudeQueryOptions(
    {
      claudeBin: 'claude',
      cwd: '/tmp',
      prompt: 'go',
      reporterSocket: '/run/atc/atc.sock',
      settings: '/state/settings-zai.json',
    },
    false,
  );

  expect(options.extraArgs).toStrictEqual({ settings: '/state/settings-zai.json' });
});

test('it passes no extra CLI arguments for a turn without a settings file', () => {
  const options = buildClaudeQueryOptions(
    { claudeBin: 'claude', cwd: '/tmp', prompt: 'go', reporterSocket: '/run/atc/atc.sock' },
    false,
  );

  expect(options).not.toContainKey('extraArgs');
});

test('it runs a compiled binary turn under the claude binary it is given', () => {
  const options = buildClaudeQueryOptions(
    {
      claudeBin: '/opt/claude/bin/claude',
      cwd: '/tmp',
      prompt: 'go',
      reporterSocket: '/run/atc/atc.sock',
    },
    true,
  );

  expect(options.pathToClaudeCodeExecutable).toBe('/opt/claude/bin/claude');
});

test('it starts a turn without the variables its session withholds', () => {
  updateEnv('ATC_TEST_WORKSPACE_CRED', 'fixture-not-a-secret');

  const options = buildClaudeQueryOptions(
    {
      claudeBin: 'claude',
      cwd: '/work/repo',
      prompt: 'keep going',
      sessionID: toSessionID('s-1'),
      reporterSocket: '/run/atc/atc.sock',
      withheldEnv: ['ATC_TEST_WORKSPACE_CRED'],
    },
    false,
  );

  expect(options.env).not.toContainKey('ATC_TEST_WORKSPACE_CRED');
  expect(options.env).toMatchObject({ ATC_SESSION_ID: 's-1' });
});
