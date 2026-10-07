import { expect, test } from 'bun:test';
import invariant from 'tiny-invariant';
import { parseConfig } from '../shared/config';
import { buildAgentAdapters } from './build-agent-adapters';
import { ClaudeAdapter } from './claude-adapter';

test('it builds two claude adapters with distinct ids and spawn plans from one registry', () => {
  const config = parseConfig({
    agents: {
      claude: { bin: 'one', args: ['--a'] },
      'claude-b': { kind: 'claude', bin: 'two', args: ['--b'] },
    },
  });

  const [first, second] = buildAgentAdapters(config);

  invariant(
    first instanceof ClaudeAdapter && second instanceof ClaudeAdapter,
    'expected two claude adapters',
  );

  const firstPlan = first.planSpawn({ prompt: '', resume: false });
  const secondPlan = second.planSpawn({ prompt: '', resume: false });

  expect({
    ids: [first.id, second.id],
    bins: [firstPlan.bin, secondPlan.bin],
    leading: [firstPlan.args[0], secondPlan.args[0]],
  }).toStrictEqual({
    ids: ['claude', 'claude-b'],
    bins: ['one', 'two'],
    leading: ['--a', '--b'],
  });

  expect(firstPlan.args).not.toStrictEqual(secondPlan.args);
});
