import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLocalPTYProvider } from '@atc/execution-local';
import { buildMockAgentAdapter, createGitFixture, getRecord, setupTempDir } from '@atc/test-utils';
import { runWorkspacesPrune } from './run-workspaces-prune';
import { startTestDaemon } from './test-utils/start-test-daemon';

// Each session runs in a workspace the daemon clones from the fixture's upstream, under a root of
// the test's own; forget keeps every folder, as a daemon from before forget cleaned up did.
async function setupTest() {
  const git = await createGitFixture({ prefix: 'atc-workspaces-prune-' });

  const root = setupTempDir('atc-workspaces-prune-root-').path;

  const daemon = await startTestDaemon({
    prefix: 'atc-workspaces-prune-daemon-',
    options: () => ({
      adapter: buildMockAgentAdapter(),
      gitTransports: ['file'],
      targets: [
        {
          id: 'local',
          kind: 'local-pty',
          options: {},
          identity: 'local:test',
          provider: createLocalPTYProvider(),
        },
      ],
      workspaceRoots: { root, targetRoots: new Map() },
      workspaceCleanup: { enabled: false, check: 'unpushed' },
    }),
  });

  const lines: string[] = [];
  const errors: string[] = [];

  const io = {
    print: (line: string) => {
      lines.push(line);
    },
    printError: (line: string) => {
      errors.push(line);
    },
  };

  // a session whose workspace and state folder a forget left behind
  const createForgottenSession = async (name: string) => {
    const spawned = await daemon.client.sendRequest('session.spawn', {
      cwd: join(root, name),
      workspace: { kind: 'git', url: `file://${git.upstream}`, ref: 'main' },
      cols: 80,
      rows: 24,
    });

    const session = getRecord(spawned, 'session');

    mkdirSync(join(daemon.directory, 'sessions', String(session['id']), 'scratch'), {
      recursive: true,
    });

    await daemon.client.sendRequest('session.kill', { session: session['id'] });
    await daemon.client.sendRequest('session.forget', { session: session['id'] });

    return {
      cwd: String(session['cwd']),
      state: join(daemon.directory, 'sessions', String(session['id'])),
    };
  };

  return { root, daemon, lines, errors, io, createForgottenSession };
}

test('it prints each folder with its verdict on a dry run, and removes nothing', async () => {
  const ctx = await setupTest();
  const clean = await ctx.createForgottenSession('shop-main');
  const dirty = await ctx.createForgottenSession('till-main');

  writeFileSync(join(dirty.cwd, 'receipt.md'), '# Tuesday\n');
  mkdirSync(join(ctx.root, 'by-hand'));

  const code = await runWorkspacesPrune(ctx.daemon.client, { remove: false, io: ctx.io });

  expect({ code, lines: ctx.lines, errors: ctx.errors }).toStrictEqual({
    code: 0,
    lines: [
      expect.stringMatching(/^remove {2}shop-main +\d\S* [KMG]?B {2}clean$/u),
      expect.stringMatching(
        /^keep {4}till-main +\d\S* [KMG]?B {2}1 uncommitted or untracked path$/u,
      ),
      expect.stringMatching(/^skip {4}by-hand +no atc record$/u),
      expect.stringMatching(/^state {3}2 folders +\d\S* [KMG]?B {2}no listed session$/u),
      expect.stringMatching(
        /^run again with --yes to remove 1 workspace and 2 state folders \(\d\S* [KMG]?B\)$/u,
      ),
    ],
    errors: [],
  });

  expect([clean.cwd, dirty.cwd, clean.state, dirty.state]).toSatisfyAll((path: string) =>
    existsSync(path),
  );
});

test('it takes away the clean workspace and the state folders with remove, and keeps the rest', async () => {
  const ctx = await setupTest();
  const clean = await ctx.createForgottenSession('shop-main');
  const dirty = await ctx.createForgottenSession('till-main');

  writeFileSync(join(dirty.cwd, 'receipt.md'), '# Tuesday\n');
  mkdirSync(join(ctx.root, 'by-hand'));

  const code = await runWorkspacesPrune(ctx.daemon.client, { remove: true, io: ctx.io });

  expect({ code, last: ctx.lines.at(-1) }).toStrictEqual({
    code: 0,
    last: expect.stringMatching(/^removed 1 workspace and 2 state folders \(\d\S* [KMG]?B\)$/u),
  });

  expect({
    clean: existsSync(clean.cwd),
    dirty: existsSync(join(dirty.cwd, 'receipt.md')),
    byHand: existsSync(join(ctx.root, 'by-hand')),
    states: [existsSync(clean.state), existsSync(dirty.state)],
  }).toStrictEqual({ clean: false, dirty: true, byHand: true, states: [false, false] });
});

test('it prints the refusal of a principal that is not the owner', async () => {
  const ctx = await setupTest();
  const client = await ctx.daemon.openClient({ principal: 'helper' });
  const code = await runWorkspacesPrune(client, { remove: true, io: ctx.io });

  expect({ code, errors: ctx.errors }).toStrictEqual({
    code: 1,
    errors: [
      "atc workspaces prune: unauthorized: workspaces.prune is open to the daemon's owner only",
    ],
  });
});
