import { expect, test } from 'bun:test';
import { buildClaudeConfigSeed } from './build-claude-config-seed';

test('it seeds the onboarding state and the outside-read offer mark Claude Code 2.1.294 reads', () => {
  const seed = buildClaudeConfigSeed(null);

  expect(JSON.parse(seed['claude-config-seed.json'] ?? '')).toStrictEqual({
    hasCompletedOnboarding: true,
    hasSeenAutoModeOutsideReadPrompt: true,
  });
});

test('it seeds folder trust and MCP approval for the trusted clone root', () => {
  const seed = buildClaudeConfigSeed('/work/repo');

  expect(JSON.parse(seed['claude-config-seed.json'] ?? '')).toStrictEqual({
    hasCompletedOnboarding: true,
    hasSeenAutoModeOutsideReadPrompt: true,
    projects: { '/work/repo': { hasTrustDialogAccepted: true, enableAllProjectMcpServers: true } },
  });
});

test("it seeds folder trust for the session's scratch folder beside the clone root's", () => {
  const seed = buildClaudeConfigSeed('/work/repo', null, '/guest/s1/scratch');

  expect(JSON.parse(seed['claude-config-seed.json'] ?? '')).toStrictEqual({
    hasCompletedOnboarding: true,
    hasSeenAutoModeOutsideReadPrompt: true,
    projects: {
      '/guest/s1/scratch': { hasTrustDialogAccepted: true },
      '/work/repo': { hasTrustDialogAccepted: true, enableAllProjectMcpServers: true },
    },
  });
});

test('it seeds folder trust for the scratch folder alone when no clone is trusted', () => {
  const seed = buildClaudeConfigSeed(null, null, '/guest/s1/scratch');

  expect(JSON.parse(seed['claude-config-seed.json'] ?? '')).toStrictEqual({
    hasCompletedOnboarding: true,
    hasSeenAutoModeOutsideReadPrompt: true,
    projects: { '/guest/s1/scratch': { hasTrustDialogAccepted: true } },
  });
});
