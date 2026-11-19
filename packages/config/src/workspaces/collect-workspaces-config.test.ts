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
    },
    errors: [],
  });
});
