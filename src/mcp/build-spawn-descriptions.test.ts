import { expect, test } from 'bun:test';
import { buildSpawnDescriptions } from './build-spawn-descriptions';

test('it names each registered agent and marks the ones that are not installed', () => {
  expect(
    buildSpawnDescriptions([
      { id: 'claude', installed: true },
      { id: 'zai', installed: true },
      { id: 'codex', installed: false },
    ]).agent,
  ).toBe(
    'Registered agent id to spawn; defaults to claude when it is registered, else the first registered agent. When this tool list was built, the host registered: claude, zai, codex (not installed). atc_agents_list returns the current list.',
  );
});

test('it names no agent when the registered agents are unknown', () => {
  const descriptions = buildSpawnDescriptions(null);

  expect(descriptions.agent).toBe(
    'Registered agent id to spawn; defaults to claude when it is registered, else the first registered agent. atc_agents_list returns the current list.',
  );

  expect(descriptions.tool).not.toInclude('registered:');
});

test('it points the spawn tool at atc_agents_list without claiming its descriptions stay current', () => {
  const tool = buildSpawnDescriptions([{ id: 'claude', installed: true }]).tool;

  expect(tool).toInclude('When this tool list was built, the host registered: claude.');
  expect(tool).toInclude('atc_agents_list returns the current agents');
});
