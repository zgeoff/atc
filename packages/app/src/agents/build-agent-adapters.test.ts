import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseConfig } from '@atc/config';
import { buildMockHostServices, setupTempDir } from '@atc/test-utils';
import invariant from 'tiny-invariant';
import { SHIPPED_HARNESS_PLUGINS } from '../plugins/shipped-harness-plugins';
import { buildAgentAdapters } from './build-agent-adapters';

function setupTest() {
  const temporaryDirectory = setupTempDir('agent-adapters-');

  return { directory: temporaryDirectory.path };
}

test('it builds two claude adapters with distinct ids and spawn plans from one registry', () => {
  const ctx = setupTest();

  const config = parseConfig(SHIPPED_HARNESS_PLUGINS, {
    agents: {
      claude: { bin: 'one', args: ['--a'] },
      'claude-b': { kind: 'claude', bin: 'two', args: ['--b'] },
    },
  });

  const [first, second] = buildAgentAdapters(config, buildMockHostServices(), null, {
    stateDir: join(ctx.directory, 'state'),
    homeDir: join(ctx.directory, 'home'),
    bridgeTarget: join(ctx.directory, 'atc-bridge'),
  });

  invariant(
    first?.profile?.kind === 'claude' && second?.profile?.kind === 'claude',
    'expected two claude adapters',
  );

  const firstPlan = first.planSpawn({ prompt: '', resume: false });
  const secondPlan = second.planSpawn({ prompt: '', resume: false });

  expect(first.id).toBe('claude');
  expect(second.id).toBe('claude-b');

  expect(firstPlan).toStrictEqual({
    bin: 'one',
    args: [
      '--a',
      '--settings',
      join(ctx.directory, 'state', 'hook-settings-claude.json'),
      '--plugin-dir',
      join(ctx.directory, 'atc-bridge'),
    ],
  });

  expect(secondPlan).toStrictEqual({
    bin: 'two',
    args: [
      '--b',
      '--settings',
      join(ctx.directory, 'state', 'hook-settings-claude-b.json'),
      '--plugin-dir',
      join(ctx.directory, 'atc-bridge'),
    ],
  });
});

test('it hands a gateway entry the settings folder, home and mod folder it is given', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.directory, 'home', '.claude'), { recursive: true });

  writeFileSync(
    join(ctx.directory, 'home', '.claude', 'settings.json'),
    JSON.stringify({ statusLine: { type: 'command', command: 'mine', padding: 3 } }),
  );

  const config = parseConfig(SHIPPED_HARNESS_PLUGINS, {
    agents: { zai: { kind: 'claude', bin: 'gw', baseURL: 'https://api.z.ai/api/anthropic' } },
  });

  const [gateway] = buildAgentAdapters(
    config,
    buildMockHostServices({ atcArgv: ['/opt/atc/bin/atc'] }),
    null,
    {
      stateDir: join(ctx.directory, 'state'),
      homeDir: join(ctx.directory, 'home'),
      bridgeTarget: join(ctx.directory, 'atc-bridge'),
    },
  );

  invariant(gateway?.profile?.kind === 'gateway', 'expected a gateway adapter');

  const plan = gateway.planSpawn({ prompt: '', resume: false });

  const settings: unknown = JSON.parse(
    readFileSync(join(ctx.directory, 'state', 'hook-settings-zai.json'), 'utf8'),
  );

  expect(plan).toStrictEqual({
    bin: 'gw',
    args: [
      '--settings',
      join(ctx.directory, 'state', 'hook-settings-zai.json'),
      '--plugin-dir',
      join(ctx.directory, 'atc-bridge'),
    ],
  });

  expect(settings).toStrictEqual({
    hooks: {
      SessionStart: [
        {
          hooks: [
            {
              type: 'command',
              command: `"/opt/atc/bin/atc" hook-report --agent='zai'`,
              timeout: 5,
            },
          ],
        },
      ],
      Notification: [
        {
          hooks: [
            {
              type: 'command',
              command: `"/opt/atc/bin/atc" hook-report --agent='zai'`,
              timeout: 5,
            },
          ],
        },
      ],
      Stop: [
        {
          hooks: [
            {
              type: 'command',
              command: `"/opt/atc/bin/atc" hook-report --agent='zai'`,
              timeout: 5,
            },
          ],
        },
      ],
      UserPromptSubmit: [
        {
          hooks: [
            {
              type: 'command',
              command: `"/opt/atc/bin/atc" hook-report --agent='zai'`,
              timeout: 5,
            },
          ],
        },
      ],
      SessionEnd: [
        {
          hooks: [
            {
              type: 'command',
              command: `"/opt/atc/bin/atc" hook-report --agent='zai'`,
              timeout: 5,
            },
          ],
        },
      ],
    },
    statusLine: {
      type: 'command',
      command: `"/opt/atc/bin/atc" statusline --agent='zai'`,
      padding: 3,
    },
    env: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic' },
  });
});
