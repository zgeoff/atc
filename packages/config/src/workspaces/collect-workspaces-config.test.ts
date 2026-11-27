import { expect, test } from 'bun:test';
import { collectWorkspacesConfig } from './collect-workspaces-config';

test('it reads the git transports, the global root, and each target root', () => {
  expect(
    collectWorkspacesConfig({
      gitTransports: ['https', 'ssh', 'http', 'file'],
      root: '~/ws',
      targets: { box: '/home/dev/ws', bad: 7, empty: '' },
    }),
  ).toStrictEqual({
    workspaces: {
      gitTransports: ['https', 'ssh', 'http', 'file'],
      root: '~/ws',
      targetRoots: new Map([['box', '/home/dev/ws']]),
      cleanup: { enabled: true, check: 'unpushed' },
      gitCredentials: new Map(),
    },
    errors: [],
  });
});

test.each([[undefined], [null], ['zgeoff'], [{}], [{ root: 7, targets: 'box' }], [{ root: '' }]])(
  'it reads no roots and the default transports from %p',
  (raw) => {
    expect(collectWorkspacesConfig(raw)).toStrictEqual({
      workspaces: {
        gitTransports: ['https', 'ssh'],
        root: null,
        targetRoots: new Map(),
        cleanup: { enabled: true, check: 'unpushed' },
        gitCredentials: new Map(),
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
      gitTransports: { invalid: error },
      root: null,
      targetRoots: new Map(),
      cleanup: { enabled: true, check: 'unpushed' },
      gitCredentials: new Map(),
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
      gitTransports: { invalid: error },
      root: null,
      targetRoots: new Map(),
      cleanup: { enabled: true, check: 'unpushed' },
      gitCredentials: new Map(),
    },
    errors: [error],
  });
});

test.each([[{ cleanup: {} }], [{ cleanup: { enabled: true, check: 'unpushed' } }]])(
  'it reads cleanup as on with the unpushed check from %p',
  (raw) => {
    expect(collectWorkspacesConfig(raw).workspaces.cleanup).toStrictEqual({
      enabled: true,
      check: 'unpushed',
    });
  },
);

test('it reads the none check', () => {
  expect(collectWorkspacesConfig({ cleanup: { check: 'none' } })).toStrictEqual({
    workspaces: {
      gitTransports: ['https', 'ssh'],
      root: null,
      targetRoots: new Map(),
      cleanup: { enabled: true, check: 'none' },
      gitCredentials: new Map(),
    },
    errors: [],
  });
});

test.each([['nnone'], [false]])(
  'it falls back to the unpushed check for %p, with a config error',
  (check) => {
    expect(collectWorkspacesConfig({ cleanup: { check } })).toStrictEqual({
      workspaces: {
        gitTransports: ['https', 'ssh'],
        root: null,
        targetRoots: new Map(),
        cleanup: { enabled: true, check: 'unpushed' },
        gitCredentials: new Map(),
      },
      errors: [
        `workspaces.cleanup.check holds ${JSON.stringify(check)}, which is neither "unpushed" nor "none"; a forget removes only a workspace whose work is pushed until it is fixed`,
      ],
    });
  },
);

test('it reads cleanup as off when the config turns it off', () => {
  expect(collectWorkspacesConfig({ cleanup: { enabled: false } })).toStrictEqual({
    workspaces: {
      gitTransports: ['https', 'ssh'],
      root: null,
      targetRoots: new Map(),
      cleanup: { enabled: false, check: 'unpushed' },
      gitCredentials: new Map(),
    },
    errors: [],
  });
});

test.each([
  [{ cleanup: 'on' }, 'workspaces.cleanup is not an object'],
  [{ cleanup: null }, 'workspaces.cleanup is not an object'],
  [{ cleanup: { enabled: 'yes' } }, 'workspaces.cleanup.enabled is not true or false'],
])('it turns cleanup off for %p, with a config error', (raw, problem) => {
  const error = `${problem}; a forget removes no workspace and no state folder until it is fixed`;

  expect(collectWorkspacesConfig(raw)).toStrictEqual({
    workspaces: {
      gitTransports: ['https', 'ssh'],
      root: null,
      targetRoots: new Map(),
      cleanup: { enabled: false, check: 'unpushed' },
      gitCredentials: new Map(),
    },
    errors: [error],
  });
});

test('it reads an empty transport list as one that allows no transport', () => {
  expect(collectWorkspacesConfig({ gitTransports: [] })).toStrictEqual({
    workspaces: {
      gitTransports: [],
      root: null,
      targetRoots: new Map(),
      cleanup: { enabled: true, check: 'unpushed' },
      gitCredentials: new Map(),
    },
    errors: [],
  });
});

test('it reads each git credential with its hosts, lowercased', () => {
  expect(
    collectWorkspacesConfig({
      gitCredentials: {
        CLONE_TOKEN: {
          hosts: [
            'GitHub.com',
            'git.example.test:8443',
            'plain.example.test:443',
            'dot.example.test.',
          ],
        },
      },
    }).workspaces.gitCredentials,
  ).toStrictEqual(
    new Map([
      [
        'CLONE_TOKEN',
        ['github.com', 'git.example.test:8443', 'plain.example.test:443', 'dot.example.test.'],
      ],
    ]),
  );
});

test('it reads no git credentials when the config lists none', () => {
  expect(collectWorkspacesConfig({}).workspaces.gitCredentials).toStrictEqual(new Map());
});

test.each([
  ['a name that is not a variable name', { 'CLONE-TOKEN': { hosts: ['github.com'] } }],
  ['an entry with no hosts', { CLONE_TOKEN: {} }],
  ['an empty host list', { CLONE_TOKEN: { hosts: [] } }],
  ['a host with a scheme', { CLONE_TOKEN: { hosts: ['https://github.com'] } }],
  ['a host with a path', { CLONE_TOKEN: { hosts: ['github.com/acme'] } }],
  ['a host with a user', { CLONE_TOKEN: { hosts: ['me@github.com'] } }],
  ['a host that is not a string', { CLONE_TOKEN: { hosts: [7] } }],
  ['a port out of range', { CLONE_TOKEN: { hosts: ['git.example.test:65536'] } }],
  ['an address that does not parse', { CLONE_TOKEN: { hosts: ['[:::]'] } }],
  ['an entry with an unknown key', { CLONE_TOKEN: { hosts: ['github.com'], scope: 'all' } }],
])('it leaves out a git credential with %s, with a config error', (_case, gitCredentials) => {
  const [name] = Object.keys(gitCredentials);

  expect(collectWorkspacesConfig({ gitCredentials })).toStrictEqual({
    workspaces: {
      gitTransports: ['https', 'ssh'],
      root: null,
      targetRoots: new Map(),
      cleanup: { enabled: true, check: 'unpushed' },
      gitCredentials: new Map(),
    },
    errors: [
      `workspaces.gitCredentials.${name} is not an environment variable name with { "hosts": [...] } of one or more host names; the daemon refuses a credentialRef that names it until it is fixed`,
    ],
  });
});

test('it reads no git credentials from a value that is not an object, with a config error', () => {
  expect(collectWorkspacesConfig({ gitCredentials: ['CLONE_TOKEN'] })).toStrictEqual({
    workspaces: {
      gitTransports: ['https', 'ssh'],
      root: null,
      targetRoots: new Map(),
      cleanup: { enabled: true, check: 'unpushed' },
      gitCredentials: new Map(),
    },
    errors: [
      'workspaces.gitCredentials is not an object of credential variables; the daemon refuses every credentialRef until it is fixed',
    ],
  });
});
