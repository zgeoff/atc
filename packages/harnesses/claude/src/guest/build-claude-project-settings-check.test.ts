import { expect, test } from 'bun:test';
import { buildClaudeProjectSettingsCheck } from './build-claude-project-settings-check';

test('it reads the settings file in the start folder and the local file up to the repository root', () => {
  const check = buildClaudeProjectSettingsCheck('claude');

  expect(check.files).toStrictEqual(['.claude/settings.json', '.claude/settings.local.json']);
  expect(check.rootFiles).toStrictEqual(['.claude/settings.local.json']);
});

test('it lets a launch start under settings that override nothing', () => {
  const check = buildClaudeProjectSettingsCheck('claude');

  const refusal = check.findRefusal(
    '/work/repo/.claude/settings.json',
    '{"env":{"EDITOR":"vim"},"permissions":{"allow":["Bash"]}}',
  );

  expect(refusal).toBeNull();
});

test('it refuses settings that set an api key helper, naming the setting and not its value', () => {
  const check = buildClaudeProjectSettingsCheck('claude');

  const refusal = check.findRefusal(
    '/work/repo/.claude/settings.json',
    '{"apiKeyHelper":"echo sk-ant-repo-secret"}',
  );

  expect(refusal).toMatchObject({
    code: 'auth_target_unsupported',
    data: {
      agent: 'claude',
      problem: 'project_settings_conflict',
      file: '/work/repo/.claude/settings.json',
      setting: 'apiKeyHelper',
    },
  });

  expect(refusal?.message).not.toInclude('sk-ant-repo-secret');
});

test('it refuses settings whose api key helper is null', () => {
  const check = buildClaudeProjectSettingsCheck('claude');
  const refusal = check.findRefusal('/work/repo/.claude/settings.json', '{"apiKeyHelper":null}');

  expect(refusal).toMatchObject({ data: { setting: 'apiKeyHelper' } });
});

test('it refuses settings whose env block sets a variable that outranks the sign-in', () => {
  const check = buildClaudeProjectSettingsCheck('claude');

  const refusal = check.findRefusal(
    '/work/repo/.claude/settings.local.json',
    '{"env":{"EDITOR":"vim","ANTHROPIC_BASE_URL":"https://proxy.example"}}',
  );

  expect(refusal).toMatchObject({ data: { setting: 'env.ANTHROPIC_BASE_URL' } });
});

test('it lets a launch start under settings whose env block is not an object', () => {
  const check = buildClaudeProjectSettingsCheck('claude');

  const refusal = check.findRefusal(
    '/work/repo/.claude/settings.json',
    '{"env":"ANTHROPIC_API_KEY"}',
  );

  expect(refusal).toBeNull();
});

test.each([
  ['content that is not JSON', '{"env":'],
  ['a JSON array', '[{"apiKeyHelper":"echo key"}]'],
  ['JSON null', 'null'],
  ['a JSON string', '"settings"'],
])('it refuses %s as settings it cannot check', (_label, content) => {
  const check = buildClaudeProjectSettingsCheck('claude');
  const refusal = check.findRefusal('/work/repo/.claude/settings.json', content);

  expect(refusal).toMatchObject({
    code: 'auth_target_unsupported',
    data: { problem: 'project_settings_conflict', setting: '(unparseable)' },
  });
});
