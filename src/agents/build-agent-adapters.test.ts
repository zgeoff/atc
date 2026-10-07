import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import invariant from 'tiny-invariant';
import { parseConfig } from '../shared/config';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { buildAgentAdapters } from './build-agent-adapters';
import { ClaudeAdapter } from './claude-adapter';
import { GatewayAdapter } from './gateway-adapter';

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

test('it hands a gateway entry the settings folder, home and mod folder it is given', () => {
  using ctx = setupTest();

  mkdirSync(join(ctx.dir, 'home', '.claude'), { recursive: true });

  writeFileSync(
    join(ctx.dir, 'home', '.claude', 'settings.json'),
    JSON.stringify({ statusLine: { type: 'command', command: 'mine', padding: 3 } }),
  );

  const config = parseConfig({
    agents: { zai: { kind: 'claude', bin: 'gw', baseURL: 'https://api.z.ai/api/anthropic' } },
  });

  const [gateway] = buildAgentAdapters(config, null, {
    stateDir: join(ctx.dir, 'state'),
    homeDir: join(ctx.dir, 'home'),
    bridgeTarget: join(ctx.dir, 'atc-bridge'),
  });

  invariant(gateway instanceof GatewayAdapter, 'expected a gateway adapter');

  const plan = gateway.planSpawn({ prompt: '', resume: false });

  const settings: unknown = JSON.parse(
    readFileSync(join(ctx.dir, 'state', 'hook-settings-zai.json'), 'utf8'),
  );

  expect(plan).toStrictEqual({
    bin: 'gw',
    args: [
      '--settings',
      join(ctx.dir, 'state', 'hook-settings-zai.json'),
      '--plugin-dir',
      join(ctx.dir, 'atc-bridge'),
    ],
  });

  expect(settings).toMatchObject({ statusLine: { padding: 3 } });
});
