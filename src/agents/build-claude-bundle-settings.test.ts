import { expect, test } from 'bun:test';
import { buildClaudeBundleSettings } from './build-claude-bundle-settings';

test('it ships the allow-listed settings and leaves every other key on the host', () => {
  const settings = buildClaudeBundleSettings(
    {
      model: 'opus[1m]',
      effortLevel: 'high',
      advisorModel: 'fable',
      outputStyle: 'STE Direct',
      autoCompactWindow: 500_000,
      autoMode: { allow: ['run the tests'], soft_deny: [], environment: ['a dev box'] },
      attribution: { commit: '', pr: '' },
      includeCoAuthoredBy: false,
      skipAutoPermissionPrompt: true,
      skipWorkflowUsageWarning: true,
      editorMode: 'vim',
      tui: 'fullscreen',
      enabledPlugins: { 'x@market': true },
      extraKnownMarketplaces: { market: { source: { source: 'github', repo: 'a/b' } } },
      apiKeyHelper: 'op read op://vault/key',
      hooks: { Stop: [] },
      feedbackDrafts: { a: 'b' },
      agentPushNotifEnabled: true,
    },
    '/home/me/.claude',
    '/guest/claude-config',
  );

  expect(settings).toStrictEqual({
    model: 'opus[1m]',
    effortLevel: 'high',
    advisorModel: 'fable',
    outputStyle: 'STE Direct',
    autoCompactWindow: 500_000,
    autoMode: { allow: ['run the tests'], soft_deny: [], environment: ['a dev box'] },
    attribution: { commit: '', pr: '' },
    includeCoAuthoredBy: false,
    skipAutoPermissionPrompt: true,
    skipWorkflowUsageWarning: true,
    editorMode: 'vim',
    tui: 'fullscreen',
    permissions: { defaultMode: 'auto' },
  });
});

test('it ships the allow-listed environment variables alone', () => {
  const settings = buildClaudeBundleSettings(
    {
      env: {
        CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
        GITHUB_TOKEN: 'ghp-host-secret',
        OP_SERVICE_ACCOUNT_TOKEN: 'ops-host-secret',
        ANTHROPIC_API_KEY: 'sk-host-secret',
      },
    },
    '/home/me/.claude',
    '/guest/claude-config',
  );

  expect(settings).toStrictEqual({
    env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' },
    permissions: { defaultMode: 'auto' },
  });
});

test('it drops an env block that holds no allow-listed variable', () => {
  const settings = buildClaudeBundleSettings(
    { env: { GITHUB_TOKEN: 'ghp-host-secret' } },
    '/home/me/.claude',
    '/guest/claude-config',
  );

  expect(settings).toStrictEqual({ permissions: { defaultMode: 'auto' } });
});

test("it keeps the host's permission rules and sets auto mode over its own default", () => {
  const settings = buildClaudeBundleSettings(
    { permissions: { allow: ['Bash(git status)'], defaultMode: 'acceptEdits' } },
    '/home/me/.claude',
    '/guest/claude-config',
  );

  expect(settings).toStrictEqual({
    permissions: { allow: ['Bash(git status)'], defaultMode: 'auto' },
  });
});

test("it points the statusline at the guest's copy of a script under the host's config folder", () => {
  const settings = buildClaudeBundleSettings(
    {
      statusLine: {
        type: 'command',
        command: 'bash "/home/me/.claude/statusline.sh" /home/me/.claude-other/x',
        padding: 2,
      },
    },
    '/home/me/.claude',
    '/guest/claude-config',
  );

  expect(settings).toStrictEqual({
    statusLine: {
      type: 'command',
      command: 'bash "/guest/claude-config/statusline.sh" /home/me/.claude-other/x',
      padding: 2,
    },
    permissions: { defaultMode: 'auto' },
  });
});

test.each([[null], ['not settings'], [{ statusLine: 'echo hi' }]])(
  'it ships auto mode alone from host settings of %p',
  (input) => {
    expect(
      buildClaudeBundleSettings(input, '/home/me/.claude', '/guest/claude-config'),
    ).toStrictEqual({ permissions: { defaultMode: 'auto' } });
  },
);
