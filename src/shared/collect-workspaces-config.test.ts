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
    expect(collectWorkspacesConfig(raw).workspaces.sources).toBeNull();
  },
);

test.each([
  ['ext', 'runs a command or reads a descriptor on the daemon host'],
  ['fd', 'runs a command or reads a descriptor on the daemon host'],
])(
  'it refuses the %p transport with a config error and keeps the default transports',
  (name, why) => {
    expect(collectWorkspacesConfig({ gitTransports: ['https', name] })).toStrictEqual({
      workspaces: {
        githubOwner: null,
        sources: null,
        gitTransports: ['https', 'ssh'],
        root: null,
        targetRoots: new Map(),
      },
      errors: [
        `workspaces.gitTransports holds '${name}', which atc never allows because it ${why}; the daemon fetches over https and ssh until it is fixed`,
      ],
    });
  },
);

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
])('it refuses the transports %p with a config error', (gitTransports, error) => {
  expect(collectWorkspacesConfig({ gitTransports })).toStrictEqual({
    workspaces: {
      githubOwner: null,
      sources: null,
      gitTransports: ['https', 'ssh'],
      root: null,
      targetRoots: new Map(),
    },
    errors: [`${error}; the daemon fetches over https and ssh until it is fixed`],
  });
});
