import { expect, test } from 'bun:test';
import { parseConfig } from '@atc/config';
import { buildStubHarnessPlugins } from '@atc/test-utils';
import { formatDaemonConfigProblems } from './format-daemon-config-problems';

test('it formats no line for a config with no problem', () => {
  const config = parseConfig(buildStubHarnessPlugins(), {}, '/c.json');

  expect(formatDaemonConfigProblems(config, [], [])).toStrictEqual([]);
});

test('it formats a config file atc cannot read as a refusal of every spawn', () => {
  const config = parseConfig(buildStubHarnessPlugins(), {}, '/c.json');

  expect(
    formatDaemonConfigProblems(
      config,
      [
        {
          scope: 'config',
          problem: 'config_malformed',
          path: '/home/river/.config/atc/config.json',
          detail: 'Unexpected token',
        },
      ],
      [],
    ),
  ).toStrictEqual([
    'atc daemon: config: /home/river/.config/atc/config.json cannot be used (config_malformed: Unexpected token); every spawn is refused, local ones included, until it is fixed',
  ]);
});

test('it formats each config problem in order, removed keys and missing sources last', () => {
  const config = parseConfig(buildStubHarnessPlugins(), {}, '/c.json');

  expect(
    formatDaemonConfigProblems(
      {
        ...config,
        principalErrors: ['principals.pc holds no token'],
        workspaceErrors: ['workspaces.root is not a path'],
        authProfileErrors: ['authProfiles.work has no helper'],
        agentErrors: ['agents.kiwi names no harness'],
        deprecations: ['dirs.roots moves to workspaces'],
        removedKeys: ['resumeInterruptedTurns'],
      },
      [{ scope: 'target', target: 'lab', problem: "target 'lab' names no provider" }],
      ['forge'],
    ),
  ).toStrictEqual([
    "atc daemon: config: target 'lab' names no provider",
    'atc daemon: config: principals.pc holds no token',
    'atc daemon: config: workspaces.root is not a path',
    'atc daemon: config: authProfiles.work has no helper',
    'atc daemon: config: agents.kiwi names no harness',
    'atc daemon: config: dirs.roots moves to workspaces',
    "atc daemon: config: config.json sets resumeInterruptedTurns, which atc no longer reads; run 'atc config migrate' to drop it",
    "atc daemon: config: workspaces.sources holds 'forge', which this daemon cannot offer; the picker leaves it out",
  ]);
});
