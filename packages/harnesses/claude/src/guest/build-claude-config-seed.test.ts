import { expect, test } from 'bun:test';
import { buildClaudeConfigSeed } from './build-claude-config-seed';

// the key is read from the published linux-x64 binary of 2.1.294, the version the imp image
// pins; a change of the pinned version checks the key again before this test changes
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
