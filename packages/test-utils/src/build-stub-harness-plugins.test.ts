import { expect, test } from 'bun:test';
import { collectAgents } from '@atc/config';
import { buildStubHarnessPlugins } from './build-stub-harness-plugins';

test('it builds stand-ins for claude, grok, and codex in that order', () => {
  expect(buildStubHarnessPlugins().map((plugin) => plugin.id)).toStrictEqual([
    'claude',
    'grok',
    'codex',
  ]);
});

test('it loads an entry of each kind on the defaults of that kind', () => {
  expect(
    collectAgents({ claude: {}, grok: {}, codex: {} }, new Map(), buildStubHarnessPlugins()),
  ).toStrictEqual({
    agents: [
      {
        id: 'claude',
        kind: 'claude',
        label: 'Claude',
        mark: 'c',
        bin: 'claude',
        args: [],
        env: {},
      },
      { id: 'grok', kind: 'grok', label: 'Grok', mark: 'g', bin: 'grok', args: [], env: {} },
      { id: 'codex', kind: 'codex', label: 'Codex', mark: 'c', bin: 'codex', args: [], env: {} },
    ],
    errors: [],
  });
});

test('it loads an entry whose auth selects no profile, since no stand-in checks auth', () => {
  expect(
    collectAgents(
      { codex: { auth: { profiles: ['missing'] } } },
      new Map(),
      buildStubHarnessPlugins(),
    ),
  ).toStrictEqual({
    agents: [
      { id: 'codex', kind: 'codex', label: 'Codex', mark: 'c', bin: 'codex', args: [], env: {} },
    ],
    errors: [],
  });
});
