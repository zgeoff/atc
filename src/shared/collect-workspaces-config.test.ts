import { expect, test } from 'bun:test';
import { collectWorkspacesConfig } from './collect-workspaces-config';

test('it reads the configured GitHub owner, source order, and git transports', () => {
  expect(
    collectWorkspacesConfig({
      githubOwner: 'zgeoff',
      sources: ['git', 'dirs'],
      gitTransports: ['https', 'ssh', 'http', 'file'],
    }),
  ).toStrictEqual({
    workspaces: {
      githubOwner: 'zgeoff',
      sources: ['git', 'dirs'],
      gitTransports: ['https', 'ssh', 'http', 'file'],
    },
    errors: [],
  });
});

test.each([
  [undefined],
  [null],
  ['zgeoff'],
  [{}],
  [{ githubOwner: 7 }],
  [{ githubOwner: '--x' }],
  [{ githubOwner: 'a/b' }],
])('it reads no GitHub owner and the default transports from %p', (raw) => {
  expect(collectWorkspacesConfig(raw)).toStrictEqual({
    workspaces: { githubOwner: null, sources: null, gitTransports: ['https', 'ssh'] },
    errors: [],
  });
});

test.each([[{ sources: 'dirs' }], [{ sources: ['dirs', 7] }], [{ sources: ['dirs', ''] }]])(
  'it reads the default source order from %p',
  (raw) => {
    expect(collectWorkspacesConfig(raw).workspaces.sources).toBeNull();
  },
);

test.each([
  ['ext', 'runs a command or reads a descriptor on the daemon host'],
  ['fd', 'runs a command or reads a descriptor on the daemon host'],
])('it reads a list holding %p as invalid, with a config error', (name, why) => {
  const error = `workspaces.gitTransports holds '${name}', which atc never allows because it ${why}; the daemon runs no git until it is fixed`;

  expect(collectWorkspacesConfig({ gitTransports: ['https', name] })).toStrictEqual({
    workspaces: { githubOwner: null, sources: null, gitTransports: { invalid: error } },
    errors: [error],
  });
});

test.each([
  [
    ['https', 'git'],
    'workspaces.gitTransports holds "git", which is not a git transport atc allows',
  ],
  [
    ['https', 'gcrypt'],
    'workspaces.gitTransports holds "gcrypt", which is not a git transport atc allows',
  ],
  [['https', 7], 'workspaces.gitTransports holds 7, which is not a git transport atc allows'],
  ['https', 'workspaces.gitTransports is not a list of git transports'],
  [null, 'workspaces.gitTransports is not a list of git transports'],
])('it reads the transports %p as invalid, with a config error', (gitTransports, problem) => {
  const error = `${problem}; the daemon runs no git until it is fixed`;

  expect(collectWorkspacesConfig({ gitTransports })).toStrictEqual({
    workspaces: { githubOwner: null, sources: null, gitTransports: { invalid: error } },
    errors: [error],
  });
});

test('it reads an empty transport list as one that allows no transport', () => {
  expect(collectWorkspacesConfig({ gitTransports: [] })).toStrictEqual({
    workspaces: { githubOwner: null, sources: null, gitTransports: [] },
    errors: [],
  });
});
