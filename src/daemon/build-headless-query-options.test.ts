import { expect, test } from 'bun:test';
import { socketPath } from '../shared/config';
import { toAgentSessionID } from '../shared/to-agent-session-id';
import { toSessionID } from '../shared/to-session-id';
import { buildHeadlessQueryOptions } from './build-headless-query-options';

test('it runs a session turn in its directory, resumed, under the auto permission mode, with its model, effort, and mod', () => {
  const options = buildHeadlessQueryOptions(
    {
      claudeBin: 'claude',
      cwd: '/work/repo',
      prompt: 'keep going',
      resume: toAgentSessionID('sess-123'),
      permissionMode: 'auto',
      sessionID: toSessionID('s-1'),
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
    ATC_SOCKET: socketPath,
  });
});

test.each(['default', 'acceptEdits', 'bypassPermissions', 'plan', 'auto', 'dontAsk'])(
  'it passes the %s permission mode to the SDK as given',
  (mode) => {
    const options = buildHeadlessQueryOptions(
      { claudeBin: 'claude', cwd: '/tmp', prompt: 'go', permissionMode: mode },
      false,
    );

    expect(options.permissionMode).toBe(mode);
  },
);

test('it leaves out a permission mode the SDK does not accept', () => {
  const options = buildHeadlessQueryOptions(
    { claudeBin: 'claude', cwd: '/tmp', prompt: 'go', permissionMode: 'yolo' },
    false,
  );

  expect(options).not.toContainKey('permissionMode');
});

test('it leaves the permission mode to the SDK when the turn names none', () => {
  const options = buildHeadlessQueryOptions(
    { claudeBin: 'claude', cwd: '/tmp', prompt: 'go' },
    false,
  );

  expect(options).not.toContainKey('permissionMode');
});

test('it leaves out an effort the SDK does not accept', () => {
  const options = buildHeadlessQueryOptions(
    { claudeBin: 'claude', cwd: '/tmp', prompt: 'go', effort: 'turbo' },
    false,
  );

  expect(options).not.toContainKey('effort');
});

test('it starts the CLI with the settings file a turn carries', () => {
  const options = buildHeadlessQueryOptions(
    { claudeBin: 'claude', cwd: '/tmp', prompt: 'go', settings: '/state/settings-zai.json' },
    false,
  );

  expect(options.extraArgs).toStrictEqual({ settings: '/state/settings-zai.json' });
});

test('it passes no extra CLI arguments for a turn without a settings file', () => {
  const options = buildHeadlessQueryOptions(
    { claudeBin: 'claude', cwd: '/tmp', prompt: 'go' },
    false,
  );

  expect(options).not.toContainKey('extraArgs');
});

test('it runs a compiled binary turn under the claude binary it is given', () => {
  const options = buildHeadlessQueryOptions(
    { claudeBin: '/opt/claude/bin/claude', cwd: '/tmp', prompt: 'go' },
    true,
  );

  expect(options.pathToClaudeCodeExecutable).toBe('/opt/claude/bin/claude');
});
