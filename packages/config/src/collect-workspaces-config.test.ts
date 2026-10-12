import { expect, test } from 'bun:test';
import { collectWorkspacesConfig } from './collect-workspaces-config';

test('it reads the GitHub owner, the source order, the git transports, the global root, and each target root', () => {
  expect(
    collectWorkspacesConfig({
      githubOwner: 'zgeoff',
      sources: ['git', 'dirs'],
      gitTransports: ['https', 'ssh', 'http', 'file'],
      root: '~/ws',
      targets: { box: '/home/dev/ws', bad: 7, empty: '' },
    }),
  ).toStrictEqual({
    workspaces: {
      githubOwner: 'zgeoff',
      sources: ['git', 'dirs'],
      gitTransports: ['https', 'ssh', 'http', 'file'],
      root: '~/ws',
      targetRoots: new Map([['box', '/home/dev/ws']]),
    },
    errors: [],
  });
});

test.each([
  [undefined],
  [null],
  ['zgeoff'],
  [{}],
  [{ githubOwner: 7, root: 7, targets: 'box' }],
  [{ githubOwner: '--x', root: '' }],
  [{ githubOwner: 'a/b' }],
])('it reads no owner, no roots, and the default transports from %p', (raw) => {
  expect(collectWorkspacesConfig(raw)).toStrictEqual({
    workspaces: {
      githubOwner: null,
      sources: null,
      gitTransports: ['https', 'ssh'],
      root: null,
      targetRoots: new Map(),
    },
    errors: [],
  });
});

test.each([[{ sources: 'dirs' }], [{ sources: ['dirs', 7] }], [{ sources: ['dirs', ''] }]])(
  'it reads the default source order from %p',
  (raw) => {
    expect(collectWorkspacesConfig(raw)).toStrictEqual({
      workspaces: {
        githubOwner: null,
        sources: null,
        gitTransports: ['https', 'ssh'],
        root: null,
        targetRoots: new Map(),
      },
      errors: [],
    });
  },
);

test.each([
  ['ext', 'runs a command or reads a descriptor on the daemon host'],
  ['fd', 'runs a command or reads a descriptor on the daemon host'],
])('it reads a list holding %p as invalid, with a config error', (name, why) => {
  const error = `workspaces.gitTransports holds '${name}', which atc never allows because it ${why}; the daemon runs no git until it is fixed`;

  expect(collectWorkspacesConfig({ gitTransports: ['https', name] })).toStrictEqual({
    workspaces: {
      githubOwner: null,
      sources: null,
      gitTransports: { invalid: error },
      root: null,
      targetRoots: new Map(),
    },
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
    workspaces: {
      githubOwner: null,
      sources: null,
      gitTransports: { invalid: error },
      root: null,
      targetRoots: new Map(),
    },
    errors: [error],
  });
});

test('it reads an empty transport list as one that allows no transport', () => {
  expect(collectWorkspacesConfig({ gitTransports: [] })).toStrictEqual({
    workspaces: {
      githubOwner: null,
      sources: null,
      gitTransports: [],
      root: null,
      targetRoots: new Map(),
    },
    errors: [],
  });
});
