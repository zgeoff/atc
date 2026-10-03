import { expect, test } from 'bun:test';
import { resolveHomeDir } from '../shared/resolve-home-dir';
import { resolveWorkspaceRoot } from './resolve-workspace-root';

test('it lands checkouts on the daemon machine under the default root in the home directory', () => {
  const root = resolveWorkspaceRoot(
    { githubOwner: null, sources: null, root: null, targetRoots: new Map() },
    { id: 'local', inPlace: true },
  );

  expect(root).toStrictEqual({ ok: true, root: `${resolveHomeDir()}/.local/share/atc/workspaces` });
});

test("it takes a target's own root over the global root", () => {
  const root = resolveWorkspaceRoot(
    {
      githubOwner: null,
      sources: null,
      root: '/srv/ws',
      targetRoots: new Map([['box', '/home/dev/ws']]),
    },
    { id: 'box', inPlace: false },
  );

  expect(root).toStrictEqual({ ok: true, root: '/home/dev/ws' });
});

test('it takes the global root on a remote target without its own', () => {
  const root = resolveWorkspaceRoot(
    { githubOwner: null, sources: null, root: '/srv/ws', targetRoots: new Map() },
    { id: 'box', inPlace: false },
  );

  expect(root).toStrictEqual({ ok: true, root: '/srv/ws' });
});

test.each([[null], ['~/ws'], ['ws']])(
  'it refuses a remote target whose root is %p',
  (configured) => {
    const root = resolveWorkspaceRoot(
      { githubOwner: null, sources: null, root: configured, targetRoots: new Map() },
      { id: 'box', inPlace: false },
    );

    expect(root).toStrictEqual({
      ok: false,
      message: 'set workspaces.targets.box in config.json to an absolute path on that target',
    });
  },
);

test('it refuses a relative root on the daemon machine', () => {
  const root = resolveWorkspaceRoot(
    { githubOwner: null, sources: null, root: 'ws', targetRoots: new Map() },
    { id: 'local', inPlace: true },
  );

  expect(root).toStrictEqual({
    ok: false,
    message: "workspaces root 'ws' must be an absolute path",
  });
});
