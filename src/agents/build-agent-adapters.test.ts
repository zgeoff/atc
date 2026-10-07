import { expect, test } from 'bun:test';
import { join } from 'node:path';
import invariant from 'tiny-invariant';
import { parseConfig } from '../shared/config';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { buildAgentAdapters } from './build-agent-adapters';
import { ClaudeAdapter } from './claude-adapter';

function setupTest() {
  return setupTempDir('agent-adapters-');
}

test('it builds two claude adapters with distinct ids and spawn plans from one registry', () => {
  using ctx = setupTest();

  const config = parseConfig({
    agents: {
      claude: { bin: 'one', args: ['--a'] },
      'claude-b': { kind: 'claude', bin: 'two', args: ['--b'] },
    },
  });

  const [first, second] = buildAgentAdapters(config, null, {
    stateDir: join(ctx.dir, 'state'),
    homeDir: join(ctx.dir, 'home'),
    bridgeTarget: join(ctx.dir, 'atc-bridge'),
  });

  invariant(
    first instanceof ClaudeAdapter && second instanceof ClaudeAdapter,
    'expected two claude adapters',
  );

  const plans = [
    first.planSpawn({ prompt: '', resume: false }),
    second.planSpawn({ prompt: '', resume: false }),
  ];

  expect({ ids: [first.id, second.id], plans }).toStrictEqual({
    ids: ['claude', 'claude-b'],
    plans: [
      {
        bin: 'one',
        args: [
          '--a',
          '--settings',
          join(ctx.dir, 'state', 'hook-settings-claude.json'),
          '--plugin-dir',
          join(ctx.dir, 'atc-bridge'),
        ],
      },
      {
        bin: 'two',
        args: [
          '--b',
          '--settings',
          join(ctx.dir, 'state', 'hook-settings-claude-b.json'),
          '--plugin-dir',
          join(ctx.dir, 'atc-bridge'),
        ],
      },
    ],
  });
});
