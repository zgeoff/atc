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

test('it formats each config problem in order, removed keys and the sources this host leaves out last', () => {
  const config = parseConfig(buildStubHarnessPlugins(), {}, '/c.json');

  expect(
    formatDaemonConfigProblems(
      {
        ...config,
        principalErrors: ['principals.pc holds no token'],
        workspaceErrors: ['workspaces.root is not a path'],
        authProfileErrors: ['authProfiles.work has no helper'],
        agentErrors: ['agents.kiwi names no harness'],
        sourceErrors: ['sources.forge: kind must be dirs, git, or github'],
        deprecations: ['dirs.roots moves to workspaces'],
        removedKeys: ['resumeInterruptedTurns'],
      },
      [{ scope: 'target', target: 'lab', problem: "target 'lab' names no provider" }],
      ["sources.github: gh is not on the daemon's PATH; left out"],
    ),
  ).toStrictEqual([
    "atc daemon: config: target 'lab' names no provider",
    'atc daemon: config: principals.pc holds no token',
    'atc daemon: config: workspaces.root is not a path',
    'atc daemon: config: authProfiles.work has no helper',
    'atc daemon: config: agents.kiwi names no harness',
    'atc daemon: config: sources.forge: kind must be dirs, git, or github',
    'atc daemon: config: dirs.roots moves to workspaces',
    "atc daemon: config: config.json sets resumeInterruptedTurns, which atc no longer reads; run 'atc config migrate' to drop it",
    "atc daemon: config: sources.github: gh is not on the daemon's PATH; left out",
  ]);
});
