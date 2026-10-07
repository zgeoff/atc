import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DAEMON_FEATURES } from '../protocol/daemon-features';
import type { DaemonFeature } from '../protocol/daemon-features';
import { buildStubDaemonRequests } from '../test-utils/build-stub-daemon-requests';
import { buildStubPickerHost } from '../test-utils/build-stub-picker-host';
import { buildStubTerminal } from '../test-utils/build-stub-terminal';
import { KEYS } from '../test-utils/keys';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { SpawnPicker } from './spawn-picker';

interface SetupConfig {
  // The features the daemon announces.
  readonly features?: readonly DaemonFeature[];

  // The rows of the terminal a spawned session gets.
  readonly ptyRows?: number;

  // The client's own directory, which the directory step lists first.
  readonly cwd?: string;
}

/**
 * A spawn picker reading its config from `configPath` in a fresh temp
 * directory, drawing into `terminal`, and talking to a daemon that answers
 * only when a test says so. `counts` records each draw, each return to the
 * screen the flow came from, each attach, and each answer the picker
 * dropped, and `dropped` holds the kind of each dropped answer in order.
 * Disposal removes the directory.
 */
function setupTest(config: SetupConfig = {}) {
  using stack = new DisposableStack();

  const tmp = stack.use(setupTempDir('atc-spawn-picker-'));

  // A test that checks the client's directory passes its own; the others
  // run from an empty one under the temp root, which the directory step
  // needs to exist.
  const cwd = config.cwd ?? join(tmp.dir, 'cwd');

  mkdirSync(join(tmp.dir, 'cwd'));

  // A test that checks a spawn's rows passes its own, and a test that needs
  // an older daemon passes its features; the others run in a 24-row
  // terminal and talk to a current daemon, which announces every feature.
  const features = new Set<DaemonFeature>(config.features ?? DAEMON_FEATURES);

  const ptyRows = config.ptyRows ?? 24;
  const host = buildStubPickerHost();
  const terminal = buildStubTerminal();
  const daemon = buildStubDaemonRequests({ countReactions: host.countReactions });
  const configPath = join(tmp.dir, 'config.json');

  const picker = new SpawnPicker<{ readonly id: string }>({
    sendRequest: (m, p) => daemon.sendRequest(m, p),
    ptyRows: () => ptyRows,
    hasDaemonFeature: (feature) => features.has(feature),
    isLeaderKey: (buf) => buf.toString() === KEYS.ctrlRightBracket,

    // The agent step preselects Claude when several agents are installed.
    getLastUsedAgent: () => 'claude',

    scheduleStatus: host.scheduleStatus,
    toBase: host.toBase,
    attach: host.attach,
    toMirrorSession: () => ({ id: 's-1' }),
    upsertMirror: () => {},
    write: terminal.write,
    cwd,
    configPath,
    onDropAnswer: host.onDropAnswer,
  });

  const owned = stack.move();

  return {
    picker,
    daemon,
    terminal,
    counts: host.counts,
    dropped: host.dropped,
    cwd,
    configPath,
    [Symbol.dispose]: () => {
      owned.dispose();
    },
  };
}

test('it drops the target and source answer that arrives after esc leaves the agent step', async () => {
  using ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({
      claudeBin: process.execPath,
      grokBin: process.execPath,
      codexBin: 'no-codex',
    }),
  );

  ctx.picker.open();
  ctx.picker.applyKey(Buffer.from(KEYS.enter));
  ctx.picker.applyKey(Buffer.from(KEYS.esc));

  const renders = ctx.counts.renders;

  await ctx.daemon.answer('agents.list', {
    targets: [
      {
        id: 'local',
        provider: 'local-pty',
        available: true,
        default: true,
        capabilities: { transfer: true, run: true },
      },
    ],
    sources: [{ id: 'fake', label: 'fake repository', kind: 'git' }],
  });

  expect(ctx.counts.exits).toBe(1);
  expect(ctx.counts.renders).toBe(renders);
  expect(ctx.dropped).toStrictEqual(['targets and sources']);
  expect(ctx.daemon.collectSent('sources.list')).toStrictEqual([]);
});

test('it drops the directory history that arrives after esc leaves a daemon without sources', async () => {
  using ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ claudeBin: process.execPath, grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  ctx.picker.open();

  await ctx.daemon.answer('agents.list', {
    targets: [
      {
        id: 'local',
        provider: 'local-pty',
        available: true,
        default: true,
        capabilities: { transfer: true, run: true },
      },
    ],
  });

  ctx.picker.applyKey(Buffer.from(KEYS.esc));

  const renders = ctx.counts.renders;

  await ctx.daemon.answer('dirs.list', { dirs: ['/srv/one'] });

  expect(ctx.counts.exits).toBe(1);
  expect(ctx.counts.renders).toBe(renders);
  expect(ctx.dropped).toStrictEqual(['local directory listing']);
});

test('it drops a git listing that arrives after the leader leaves the flow', async () => {
  using ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ claudeBin: process.execPath, grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  ctx.picker.open();

  await ctx.daemon.answer('agents.list', {
    targets: [
      {
        id: 'local',
        provider: 'local-pty',
        available: true,
        default: true,
        capabilities: { transfer: true, run: true },
      },
    ],
    sources: [{ id: 'fake', label: 'fake repository', kind: 'git' }],
  });

  ctx.picker.applyKey(Buffer.from(KEYS.ctrlRightBracket));

  const renders = ctx.counts.renders;

  await ctx.daemon.answer('sources.list', {
    source: 'fake',
    scope: null,
    candidates: [{ label: 'app', pick: { kind: 'git', url: 'https://example.com/app.git' } }],
  });

  expect(ctx.counts.exits).toBe(1);
  expect(ctx.counts.renders).toBe(renders);
  expect(ctx.dropped).toStrictEqual(['listing']);
});

test('it drops a directory listing that arrives after the leader leaves the flow', async () => {
  using ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ claudeBin: process.execPath, grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  ctx.picker.open();

  await ctx.daemon.answer('agents.list', {
    targets: [
      {
        id: 'local',
        provider: 'local-pty',
        available: true,
        default: true,
        capabilities: { transfer: true, run: true },
      },
    ],
    sources: [{ id: 'dirs', label: 'directory on the daemon host', kind: 'path' }],
  });

  ctx.picker.applyKey(Buffer.from(KEYS.ctrlRightBracket));

  const renders = ctx.counts.renders;

  await ctx.daemon.answer('sources.list', {
    source: 'dirs',
    scope: null,
    candidates: [{ label: '/srv/one', pick: { kind: 'path', dir: '/srv/one' } }],
  });

  expect(ctx.counts.exits).toBe(1);
  expect(ctx.counts.renders).toBe(renders);
  expect(ctx.dropped).toStrictEqual(['directory listing']);
});

test('it drops a reading that arrives after the leader leaves the flow', async () => {
  using ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ claudeBin: process.execPath, grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  ctx.picker.open();

  await ctx.daemon.answer('agents.list', {
    targets: [
      {
        id: 'local',
        provider: 'local-pty',
        available: true,
        default: true,
        capabilities: { transfer: true, run: true },
      },
    ],
    sources: [{ id: 'fake', label: 'fake repository', kind: 'git' }],
  });

  await ctx.daemon.answer('sources.list', { source: 'fake', scope: null, candidates: [] });

  ctx.picker.applyKey(Buffer.from('acme/'));
  ctx.picker.applyKey(Buffer.from(KEYS.enter));
  ctx.picker.applyKey(Buffer.from(KEYS.ctrlRightBracket));

  const renders = ctx.counts.renders;

  await ctx.daemon.answer('sources.interpret', { kind: 'browse', scope: 'acme' });

  expect(ctx.counts.exits).toBe(1);
  expect(ctx.counts.renders).toBe(renders);
  expect(ctx.dropped).toStrictEqual(['interpret']);

  expect(ctx.daemon.collectSent('sources.list')).toStrictEqual([
    { source: 'fake', target: 'local' },
  ]);
});

test('it drops a probe answer that arrives after esc cancels it and the leader leaves', async () => {
  using ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ claudeBin: process.execPath, grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  ctx.picker.open();

  await ctx.daemon.answer('agents.list', {
    targets: [
      {
        id: 'local',
        provider: 'local-pty',
        available: true,
        default: true,
        capabilities: { transfer: true, run: true },
      },
    ],
    sources: [{ id: 'fake', label: 'fake repository', kind: 'git' }],
  });

  await ctx.daemon.answer('sources.list', { source: 'fake', scope: null, candidates: [] });

  ctx.picker.applyKey(Buffer.from('https://example.com/app.git'));
  ctx.picker.applyKey(Buffer.from(KEYS.enter));
  ctx.picker.applyKey(Buffer.from(KEYS.esc));
  ctx.picker.applyKey(Buffer.from(KEYS.ctrlRightBracket));

  const renders = ctx.counts.renders;

  await ctx.daemon.answer('git.probe', {
    url: 'https://example.com/app.git',
    head: 'main',
    refs: [{ name: 'main', kind: 'branch', sha: 'a'.repeat(40) }],
    resolved: null,
  });

  expect(ctx.counts.exits).toBe(1);
  expect(ctx.counts.renders).toBe(renders);
  expect(ctx.dropped).toStrictEqual(['probe']);
});

test('it neither attaches nor draws a spawn that answers after esc stops waiting on it', async () => {
  using ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ claudeBin: process.execPath, grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  ctx.picker.open();

  await ctx.daemon.answer('agents.list', {
    targets: [
      {
        id: 'local',
        provider: 'local-pty',
        available: true,
        default: true,
        capabilities: { transfer: true, run: true },
      },
    ],
    sources: [{ id: 'dirs', label: 'directory on the daemon host', kind: 'path' }],
  });

  await ctx.daemon.answer('sources.list', { source: 'dirs', scope: null, candidates: [] });

  ctx.picker.applyKey(Buffer.from(KEYS.enter));
  ctx.picker.applyKey(Buffer.from(KEYS.enter));
  ctx.picker.applyKey(Buffer.from(KEYS.enter));
  ctx.picker.applyKey(Buffer.from(KEYS.esc));

  const renders = ctx.counts.renders;

  await ctx.daemon.answer('session.spawn', { session: { id: 's-1' } });

  expect(ctx.counts.exits).toBe(1);
  expect(ctx.counts.renders).toBe(renders);
  expect(ctx.dropped).toStrictEqual(['spawn']);
  expect(ctx.counts.attached).toBe(0);
});

test('it materializes a directory on the one target when that target is remote', async () => {
  using ctx = setupTest({ ptyRows: 24 });

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ claudeBin: process.execPath, grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  ctx.picker.open();

  await ctx.daemon.answer('agents.list', {
    targets: [
      {
        id: 'box',
        provider: 'imp',
        available: true,
        default: false,
        capabilities: { transfer: true, run: true },
      },
    ],
    sources: [{ id: 'dirs', label: 'directory on the daemon host', kind: 'path' }],
  });

  await ctx.daemon.answer('sources.list', { source: 'dirs', scope: null, candidates: [] });

  ctx.picker.applyKey(Buffer.from(KEYS.enter));
  ctx.picker.applyKey(Buffer.from(KEYS.enter));
  ctx.picker.applyKey(Buffer.from(KEYS.enter));

  expect(ctx.daemon.collectSent('session.spawn')).toStrictEqual([
    {
      cwd: ctx.cwd,
      name: '',
      prompt: '',
      cols: expect.any(Number),
      rows: 24,
      agent: 'claude',
      target: 'box',
      workspace: { kind: 'path', path: ctx.cwd },
    },
  ]);
});

test("it shows the daemon's pick for the destination of a repository on a remote target with no destination typed", async () => {
  using ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ claudeBin: process.execPath, grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  ctx.picker.open();

  await ctx.daemon.answer('agents.list', {
    targets: [
      {
        id: 'box',
        provider: 'imp',
        available: true,
        default: false,
        capabilities: { transfer: true, run: true },
      },
    ],
    sources: [{ id: 'fake', label: 'fake repository', kind: 'git' }],
  });

  await ctx.daemon.answer('sources.list', { source: 'fake', scope: null, candidates: [] });

  ctx.picker.applyKey(Buffer.from('https://example.com/app.git'));
  ctx.picker.applyKey(Buffer.from(KEYS.enter));

  await ctx.daemon.answer('git.probe', {
    url: 'https://example.com/app.git',
    head: 'main',
    refs: [{ name: 'main', kind: 'branch', sha: 'a'.repeat(40) }],
    resolved: null,
  });

  ctx.terminal.reset();
  ctx.picker.applyKey(Buffer.from(KEYS.enter));

  expect(ctx.terminal.getText()).toInclude(
    'dest    box:~/.local/share/atc/workspaces/app-main-aaaaaaa',
  );
});

test('it spawns a repository on a remote target with no destination typed and leaves the directory to the daemon', async () => {
  using ctx = setupTest({ ptyRows: 24 });

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ claudeBin: process.execPath, grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  ctx.picker.open();

  await ctx.daemon.answer('agents.list', {
    targets: [
      {
        id: 'box',
        provider: 'imp',
        available: true,
        default: false,
        capabilities: { transfer: true, run: true },
      },
    ],
    sources: [{ id: 'fake', label: 'fake repository', kind: 'git' }],
  });

  await ctx.daemon.answer('sources.list', { source: 'fake', scope: null, candidates: [] });

  ctx.picker.applyKey(Buffer.from('https://example.com/app.git'));
  ctx.picker.applyKey(Buffer.from(KEYS.enter));

  await ctx.daemon.answer('git.probe', {
    url: 'https://example.com/app.git',
    head: 'main',
    refs: [{ name: 'main', kind: 'branch', sha: 'a'.repeat(40) }],
    resolved: null,
  });

  ctx.picker.applyKey(Buffer.from(KEYS.enter));
  ctx.picker.applyKey(Buffer.from(KEYS.enter));
  ctx.picker.applyKey(Buffer.from(KEYS.enter));
  ctx.picker.applyKey(Buffer.from(KEYS.enter));

  expect(ctx.daemon.collectSent('session.spawn')).toStrictEqual([
    {
      name: '',
      prompt: '',
      cols: expect.any(Number),
      rows: 24,
      agent: 'claude',
      target: 'box',
      workspace: {
        kind: 'git',
        url: 'https://example.com/app.git',
        ref: 'main',
        sha: 'a'.repeat(40),
      },
    },
  ]);
});

test('it sends the directory of a directory spawn after a flow left a repository to the daemon', async () => {
  using ctx = setupTest({ ptyRows: 24 });

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ claudeBin: process.execPath, grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  ctx.picker.open();

  await ctx.daemon.answer('agents.list', {
    targets: [
      {
        id: 'box',
        provider: 'imp',
        available: true,
        default: false,
        capabilities: { transfer: true, run: true },
      },
    ],
    sources: [{ id: 'fake', label: 'fake repository', kind: 'git' }],
  });

  await ctx.daemon.answer('sources.list', { source: 'fake', scope: null, candidates: [] });

  ctx.picker.applyKey(Buffer.from('https://example.com/app.git'));
  ctx.picker.applyKey(Buffer.from(KEYS.enter));

  await ctx.daemon.answer('git.probe', {
    url: 'https://example.com/app.git',
    head: 'main',
    refs: [{ name: 'main', kind: 'branch', sha: 'a'.repeat(40) }],
    resolved: null,
  });

  ctx.picker.applyKey(Buffer.from(KEYS.enter));
  ctx.picker.applyKey(Buffer.from(KEYS.ctrlRightBracket));
  ctx.picker.open();

  await ctx.daemon.answer('agents.list', {
    targets: [
      {
        id: 'box',
        provider: 'imp',
        available: true,
        default: false,
        capabilities: { transfer: true, run: true },
      },
    ],
    sources: [{ id: 'dirs', label: 'directory on the daemon host', kind: 'path' }],
  });

  await ctx.daemon.answer('sources.list', { source: 'dirs', scope: null, candidates: [] });

  ctx.picker.applyKey(Buffer.from(KEYS.enter));
  ctx.picker.applyKey(Buffer.from(KEYS.enter));
  ctx.picker.applyKey(Buffer.from(KEYS.enter));

  expect(ctx.daemon.collectSent('session.spawn')).toStrictEqual([
    {
      cwd: ctx.cwd,
      name: '',
      prompt: '',
      cols: expect.any(Number),
      rows: 24,
      agent: 'claude',
      target: 'box',
      workspace: { kind: 'path', path: ctx.cwd },
    },
  ]);
});

test('it shows the refusal of a remote target without a workspace root when the daemon cannot pick the directory', async () => {
  // A daemon that serves every feature but picking the directory itself.
  using ctx = setupTest({
    features: DAEMON_FEATURES.filter((feature) => feature !== 'spawn.workspace.autoDir'),
  });

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ claudeBin: process.execPath, grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  ctx.picker.open();

  await ctx.daemon.answer('agents.list', {
    targets: [
      {
        id: 'box',
        provider: 'imp',
        available: true,
        default: false,
        capabilities: { transfer: true, run: true },
      },
    ],
    sources: [{ id: 'fake', label: 'fake repository', kind: 'git' }],
  });

  await ctx.daemon.answer('sources.list', { source: 'fake', scope: null, candidates: [] });

  ctx.picker.applyKey(Buffer.from('https://example.com/app.git'));
  ctx.picker.applyKey(Buffer.from(KEYS.enter));

  await ctx.daemon.answer('git.probe', {
    url: 'https://example.com/app.git',
    head: 'main',
    refs: [{ name: 'main', kind: 'branch', sha: 'a'.repeat(40) }],
    resolved: null,
  });

  ctx.terminal.reset();
  ctx.picker.applyKey(Buffer.from(KEYS.enter));

  expect(ctx.terminal.getText()).toInclude('set workspaces.targets.box in config.json');
});

test('it sends no spawn to a remote target without a workspace root when the daemon cannot pick the directory', async () => {
  // A daemon that serves every feature but picking the directory itself.
  using ctx = setupTest({
    features: DAEMON_FEATURES.filter((feature) => feature !== 'spawn.workspace.autoDir'),
  });

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ claudeBin: process.execPath, grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  ctx.picker.open();

  await ctx.daemon.answer('agents.list', {
    targets: [
      {
        id: 'box',
        provider: 'imp',
        available: true,
        default: false,
        capabilities: { transfer: true, run: true },
      },
    ],
    sources: [{ id: 'fake', label: 'fake repository', kind: 'git' }],
  });

  await ctx.daemon.answer('sources.list', { source: 'fake', scope: null, candidates: [] });

  ctx.picker.applyKey(Buffer.from('https://example.com/app.git'));
  ctx.picker.applyKey(Buffer.from(KEYS.enter));

  await ctx.daemon.answer('git.probe', {
    url: 'https://example.com/app.git',
    head: 'main',
    refs: [{ name: 'main', kind: 'branch', sha: 'a'.repeat(40) }],
    resolved: null,
  });

  ctx.picker.applyKey(Buffer.from(KEYS.enter));
  ctx.picker.applyKey(Buffer.from(KEYS.enter));
  ctx.picker.applyKey(Buffer.from(KEYS.enter));
  ctx.picker.applyKey(Buffer.from(KEYS.enter));

  expect(ctx.daemon.collectSent('session.spawn')).toStrictEqual([]);
});

test('it holds a session whose workspace left changes behind instead of attaching it', async () => {
  using ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ claudeBin: process.execPath, grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  ctx.picker.open();

  await ctx.daemon.answer('agents.list', {
    targets: [
      {
        id: 'box',
        provider: 'imp',
        available: true,
        default: false,
        capabilities: { transfer: true, run: true },
      },
    ],
    sources: [{ id: 'dirs', label: 'directory on the daemon host', kind: 'path' }],
  });

  await ctx.daemon.answer('sources.list', { source: 'dirs', scope: null, candidates: [] });

  ctx.picker.applyKey(Buffer.from(KEYS.enter));
  ctx.picker.applyKey(Buffer.from(KEYS.enter));
  ctx.picker.applyKey(Buffer.from(KEYS.enter));

  await ctx.daemon.answer('session.spawn', {
    session: { id: 's-1' },
    warnings: [
      'cloned commit 0123456789ab; left 2 uncommitted or untracked paths behind in /src/app',
    ],
  });

  expect(ctx.counts.attached).toBe(0);
  expect(ctx.counts.exits).toBe(0);
});

test('it attaches a held session whose workspace left changes behind on enter', async () => {
  using ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ claudeBin: process.execPath, grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  ctx.picker.open();

  await ctx.daemon.answer('agents.list', {
    targets: [
      {
        id: 'box',
        provider: 'imp',
        available: true,
        default: false,
        capabilities: { transfer: true, run: true },
      },
    ],
    sources: [{ id: 'dirs', label: 'directory on the daemon host', kind: 'path' }],
  });

  await ctx.daemon.answer('sources.list', { source: 'dirs', scope: null, candidates: [] });

  ctx.picker.applyKey(Buffer.from(KEYS.enter));
  ctx.picker.applyKey(Buffer.from(KEYS.enter));
  ctx.picker.applyKey(Buffer.from(KEYS.enter));

  await ctx.daemon.answer('session.spawn', {
    session: { id: 's-1' },
    warnings: [
      'cloned commit 0123456789ab; left 2 uncommitted or untracked paths behind in /src/app',
    ],
  });

  ctx.picker.applyKey(Buffer.from(KEYS.enter));

  expect(ctx.counts.attached).toBe(1);
  expect(ctx.counts.exits).toBe(0);
});

test('it shows the whole note of a workspace that left changes behind, wrapped to the picker', async () => {
  using ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ claudeBin: process.execPath, grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  ctx.picker.open();

  await ctx.daemon.answer('agents.list', {
    targets: [
      {
        id: 'box',
        provider: 'imp',
        available: true,
        default: false,
        capabilities: { transfer: true, run: true },
      },
    ],
    sources: [{ id: 'dirs', label: 'directory on the daemon host', kind: 'path' }],
  });

  await ctx.daemon.answer('sources.list', { source: 'dirs', scope: null, candidates: [] });

  ctx.picker.applyKey(Buffer.from(KEYS.enter));
  ctx.picker.applyKey(Buffer.from(KEYS.enter));
  ctx.picker.applyKey(Buffer.from(KEYS.enter));
  ctx.terminal.reset();

  await ctx.daemon.answer('session.spawn', {
    session: { id: 's-1' },
    warnings: [
      'cloned commit 0123456789ab; left 12 uncommitted or untracked paths behind in /home/me/src/a-project-with-a-long-name',
    ],
  });

  const shown = ctx.terminal.getText();

  expect(shown).toInclude('/home/me/src/a-project-with-a-long-name');
  expect(shown).toInclude('0123456789ab');
  expect(shown).not.toInclude('…');
});

test('it leaves a session whose workspace left changes behind running when esc returns', async () => {
  using ctx = setupTest({ ptyRows: 24 });

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ claudeBin: process.execPath, grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  ctx.picker.open();

  await ctx.daemon.answer('agents.list', {
    targets: [
      {
        id: 'box',
        provider: 'imp',
        available: true,
        default: false,
        capabilities: { transfer: true, run: true },
      },
    ],
    sources: [{ id: 'dirs', label: 'directory on the daemon host', kind: 'path' }],
  });

  await ctx.daemon.answer('sources.list', { source: 'dirs', scope: null, candidates: [] });

  ctx.picker.applyKey(Buffer.from(KEYS.enter));
  ctx.picker.applyKey(Buffer.from(KEYS.enter));
  ctx.picker.applyKey(Buffer.from(KEYS.enter));

  await ctx.daemon.answer('session.spawn', {
    session: { id: 's-1' },
    warnings: [
      'cloned commit 0123456789ab; left 1 uncommitted or untracked path behind in /src/app',
    ],
  });

  ctx.picker.applyKey(Buffer.from(KEYS.esc));

  expect(ctx.counts.attached).toBe(0);
  expect(ctx.counts.exits).toBe(1);

  expect(ctx.daemon.collectSent('session.spawn')).toStrictEqual([
    {
      cwd: ctx.cwd,
      name: '',
      prompt: '',
      cols: expect.any(Number),
      rows: 24,
      agent: 'claude',
      target: 'box',
      workspace: { kind: 'path', path: ctx.cwd },
    },
  ]);
});

test('it attaches a session spawned without warnings at once', async () => {
  using ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ claudeBin: process.execPath, grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  ctx.picker.open();

  await ctx.daemon.answer('agents.list', {
    targets: [
      {
        id: 'box',
        provider: 'imp',
        available: true,
        default: false,
        capabilities: { transfer: true, run: true },
      },
    ],
    sources: [{ id: 'dirs', label: 'directory on the daemon host', kind: 'path' }],
  });

  await ctx.daemon.answer('sources.list', { source: 'dirs', scope: null, candidates: [] });

  ctx.picker.applyKey(Buffer.from(KEYS.enter));
  ctx.picker.applyKey(Buffer.from(KEYS.enter));
  ctx.picker.applyKey(Buffer.from(KEYS.enter));

  await ctx.daemon.answer('session.spawn', { session: { id: 's-1' } });

  expect(ctx.counts.attached).toBe(1);
});

test('it runs a directory in place on the one target when that target is local', async () => {
  using ctx = setupTest({ ptyRows: 24 });

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ claudeBin: process.execPath, grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  ctx.picker.open();

  await ctx.daemon.answer('agents.list', {
    targets: [
      {
        id: 'local',
        provider: 'local-pty',
        available: true,
        default: true,
        capabilities: { transfer: true, run: true },
      },
    ],
    sources: [{ id: 'dirs', label: 'directory on the daemon host', kind: 'path' }],
  });

  await ctx.daemon.answer('sources.list', { source: 'dirs', scope: null, candidates: [] });

  ctx.picker.applyKey(Buffer.from(KEYS.enter));
  ctx.picker.applyKey(Buffer.from(KEYS.enter));
  ctx.picker.applyKey(Buffer.from(KEYS.enter));

  expect(ctx.daemon.collectSent('session.spawn')).toStrictEqual([
    {
      cwd: ctx.cwd,
      name: '',
      prompt: '',
      cols: expect.any(Number),
      rows: 24,
      agent: 'claude',
      target: 'local',
    },
  ]);
});

test('it adopts in place on the one local target it offers', async () => {
  using ctx = setupTest({ ptyRows: 24 });

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ claudeBin: process.execPath, grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  ctx.picker.open(true);

  await ctx.daemon.answer('agents.list', {
    targets: [
      {
        id: 'box',
        provider: 'imp',
        available: true,
        default: false,
        capabilities: { transfer: true, run: true },
      },
      {
        id: 'local',
        provider: 'local-pty',
        available: true,
        default: true,
        capabilities: { transfer: true, run: true },
      },
    ],
    sources: [{ id: 'dirs', label: 'directory on the daemon host', kind: 'path' }],
  });

  await ctx.daemon.answer('sources.list', { source: 'dirs', scope: null, candidates: [] });

  ctx.picker.applyKey(Buffer.from(KEYS.enter));
  ctx.picker.applyKey(Buffer.from(KEYS.enter));

  expect(ctx.daemon.collectSent('session.spawn')).toStrictEqual([
    {
      cwd: ctx.cwd,
      name: '',
      prompt: '',
      cols: expect.any(Number),
      rows: 24,
      resume: true,
      agent: 'claude',
      target: 'local',
    },
  ]);
});

test('it offers an agent that takes the broker credential only the targets that reach the broker', async () => {
  using ctx = setupTest({ ptyRows: 24 });

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ claudeBin: process.execPath, grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  ctx.picker.open();

  await ctx.daemon.answer('agents.list', {
    agents: [{ id: 'claude', brokerAuth: true }],
    targets: [
      {
        id: 'local',
        provider: 'local-pty',
        available: true,
        default: true,
        capabilities: { transfer: true, run: true },
      },
      {
        id: 'box',
        provider: 'imp',
        available: true,
        default: false,
        capabilities: { transfer: true, run: true },
        brokerAuth: true,
      },
    ],
    sources: [{ id: 'dirs', label: 'directory on the daemon host', kind: 'path' }],
  });

  await ctx.daemon.answer('sources.list', { source: 'dirs', scope: null, candidates: [] });

  ctx.picker.applyKey(Buffer.from(KEYS.enter));
  ctx.picker.applyKey(Buffer.from(KEYS.enter));
  ctx.picker.applyKey(Buffer.from(KEYS.enter));

  expect(ctx.daemon.collectSent('session.spawn')).toStrictEqual([
    {
      cwd: ctx.cwd,
      name: '',
      prompt: '',
      cols: expect.any(Number),
      rows: 24,
      agent: 'claude',
      target: 'box',
      workspace: { kind: 'path', path: ctx.cwd },
    },
  ]);
});

test('it offers an agent that takes no broker credential every target', async () => {
  using ctx = setupTest({ ptyRows: 24 });

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ claudeBin: process.execPath, grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  ctx.picker.open();

  await ctx.daemon.answer('agents.list', {
    agents: [{ id: 'claude', brokerAuth: false }],
    targets: [
      {
        id: 'local',
        provider: 'local-pty',
        available: true,
        default: true,
        capabilities: { transfer: true, run: true },
      },
      {
        id: 'box',
        provider: 'imp',
        available: true,
        default: false,
        capabilities: { transfer: true, run: true },
        brokerAuth: true,
      },
    ],
    sources: [{ id: 'dirs', label: 'directory on the daemon host', kind: 'path' }],
  });

  await ctx.daemon.answer('sources.list', { source: 'dirs', scope: null, candidates: [] });

  ctx.picker.applyKey(Buffer.from(KEYS.enter));
  ctx.picker.applyKey(Buffer.from(KEYS.enter));
  ctx.picker.applyKey(Buffer.from(KEYS.enter));
  ctx.picker.applyKey(Buffer.from(KEYS.enter));

  expect(ctx.daemon.collectSent('session.spawn')).toStrictEqual([
    {
      cwd: ctx.cwd,
      name: '',
      prompt: '',
      cols: expect.any(Number),
      rows: 24,
      agent: 'claude',
      target: 'local',
    },
  ]);
});

test('it offers every target to an agent whose broker credential is optional', async () => {
  using ctx = setupTest({ ptyRows: 24 });

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ claudeBin: process.execPath, grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  ctx.picker.open();

  await ctx.daemon.answer('agents.list', {
    agents: [{ id: 'claude', brokerAuth: true, brokerRequired: false }],
    targets: [
      {
        id: 'local',
        provider: 'local-pty',
        available: true,
        default: true,
        capabilities: { transfer: true, run: true },
      },
      {
        id: 'box',
        provider: 'imp',
        available: true,
        default: false,
        capabilities: { transfer: true, run: true },
        brokerAuth: true,
      },
    ],
    sources: [{ id: 'dirs', label: 'directory on the daemon host', kind: 'path' }],
  });

  await ctx.daemon.answer('sources.list', { source: 'dirs', scope: null, candidates: [] });

  ctx.picker.applyKey(Buffer.from(KEYS.enter));
  ctx.picker.applyKey(Buffer.from(KEYS.enter));
  ctx.picker.applyKey(Buffer.from(KEYS.enter));
  ctx.picker.applyKey(Buffer.from(KEYS.enter));

  expect(ctx.daemon.collectSent('session.spawn')).toStrictEqual([
    {
      cwd: ctx.cwd,
      name: '',
      prompt: '',
      cols: expect.any(Number),
      rows: 24,
      agent: 'claude',
      target: 'local',
    },
  ]);
});

test('it lists a scope read from typed text once, on the target chosen after it', async () => {
  // Typed text fuzzy-filters the directories the step lists before the
  // sources read it, and a path under the temp root can hold every letter
  // of the scope in order, so the client runs from the filesystem root.
  using ctx = setupTest({ cwd: '/' });

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ claudeBin: process.execPath, grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  ctx.picker.open();

  await ctx.daemon.answer('agents.list', {
    targets: [
      {
        id: 'local',
        provider: 'local-pty',
        available: true,
        default: true,
        capabilities: { transfer: true, run: true },
      },
      {
        id: 'box',
        provider: 'imp',
        available: true,
        default: false,
        capabilities: { transfer: true, run: true },
      },
    ],
    sources: [
      { id: 'dirs', label: 'directory on the daemon host', kind: 'path' },
      { id: 'fake', label: 'fake repository', kind: 'git' },
    ],
  });

  await ctx.daemon.answer('sources.list', { source: 'dirs', scope: null, candidates: [] });

  ctx.picker.applyKey(Buffer.from('acme/'));
  ctx.picker.applyKey(Buffer.from(KEYS.enter));

  await ctx.daemon.answer('sources.interpret', { kind: 'none' });
  await ctx.daemon.answer('sources.interpret', { kind: 'browse', scope: 'acme' });

  ctx.picker.applyKey(Buffer.from(KEYS.down));
  ctx.picker.applyKey(Buffer.from(KEYS.enter));

  expect(
    ctx.daemon.collectSent('sources.list').filter((p) => p['source'] === 'fake'),
  ).toStrictEqual([{ source: 'fake', scope: 'acme', target: 'box' }]);
});

test('it starts a new flow on the default target, not the one the last flow chose', async () => {
  using ctx = setupTest({ ptyRows: 24 });

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ claudeBin: process.execPath, grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  ctx.picker.open();

  await ctx.daemon.answer('agents.list', {
    targets: [
      {
        id: 'local',
        provider: 'local-pty',
        available: true,
        default: true,
        capabilities: { transfer: true, run: true },
      },
      {
        id: 'box',
        provider: 'imp',
        available: true,
        default: false,
        capabilities: { transfer: true, run: true },
      },
    ],
    sources: [{ id: 'dirs', label: 'directory on the daemon host', kind: 'path' }],
  });

  await ctx.daemon.answer('sources.list', { source: 'dirs', scope: null, candidates: [] });

  ctx.picker.applyKey(Buffer.from(KEYS.enter));
  ctx.picker.applyKey(Buffer.from(KEYS.down));
  ctx.picker.applyKey(Buffer.from(KEYS.enter));
  ctx.picker.applyKey(Buffer.from(KEYS.enter));
  ctx.picker.applyKey(Buffer.from(KEYS.enter));

  await ctx.daemon.answer('session.spawn', { session: { id: 's-1' } });

  ctx.picker.open();

  await ctx.daemon.answer('agents.list', {
    targets: [
      {
        id: 'local',
        provider: 'local-pty',
        available: true,
        default: true,
        capabilities: { transfer: true, run: true },
      },
      {
        id: 'box',
        provider: 'imp',
        available: true,
        default: false,
        capabilities: { transfer: true, run: true },
      },
    ],
    sources: [{ id: 'dirs', label: 'directory on the daemon host', kind: 'path' }],
  });

  await ctx.daemon.answer('sources.list', { source: 'dirs', scope: null, candidates: [] });

  ctx.picker.applyKey(Buffer.from(KEYS.enter));
  ctx.picker.applyKey(Buffer.from(KEYS.enter));
  ctx.picker.applyKey(Buffer.from(KEYS.enter));
  ctx.picker.applyKey(Buffer.from(KEYS.enter));

  expect(ctx.daemon.collectSent('session.spawn')).toStrictEqual([
    {
      cwd: ctx.cwd,
      name: '',
      prompt: '',
      cols: expect.any(Number),
      rows: 24,
      agent: 'claude',
      target: 'box',
      workspace: { kind: 'path', path: ctx.cwd },
    },
    {
      cwd: ctx.cwd,
      name: '',
      prompt: '',
      cols: expect.any(Number),
      rows: 24,
      agent: 'claude',
      target: 'local',
    },
  ]);
});

test('it lists a git source again when the flow left it before its listing answered', async () => {
  using ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ claudeBin: process.execPath, grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  ctx.picker.open();

  await ctx.daemon.answer('agents.list', {
    targets: [
      {
        id: 'local',
        provider: 'local-pty',
        available: true,
        default: true,
        capabilities: { transfer: true, run: true },
      },
    ],
    sources: [
      { id: 'fake', label: 'fake repository', kind: 'git' },
      { id: 'dirs', label: 'directory on the daemon host', kind: 'path' },
    ],
  });

  ctx.picker.applyKey(Buffer.from(KEYS.tab));

  await ctx.daemon.answer('sources.list', { source: 'dirs', scope: null, candidates: [] });

  ctx.picker.applyKey(Buffer.from(KEYS.tab));

  expect(ctx.daemon.collectSent('sources.list')).toStrictEqual([
    { source: 'fake', target: 'local' },
    { source: 'dirs' },
    { source: 'fake', target: 'local' },
  ]);
});

test('it reads the targets and sources at once when one agent is installed', () => {
  using ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ claudeBin: process.execPath, grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  ctx.picker.open();

  expect(ctx.daemon.collectSent('agents.list')).toStrictEqual([{}]);
});

test('it waits on the agent choice when more than one agent is installed', () => {
  using ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({
      claudeBin: process.execPath,
      grokBin: process.execPath,
      codexBin: 'no-codex',
    }),
  );

  ctx.picker.open();

  expect(ctx.daemon.collectSent('agents.list')).toStrictEqual([]);
});

test('it shows how to install an agent when none is installed', () => {
  using ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ claudeBin: 'no-claude', grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  ctx.picker.open();

  expect(ctx.terminal.getText()).toInclude('no agent CLI found');
  expect(ctx.daemon.collectSent('agents.list')).toStrictEqual([]);
});

test('it reads the targets and sources once when enter repeats on the agent step', () => {
  using ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({
      claudeBin: process.execPath,
      grokBin: process.execPath,
      codexBin: 'no-codex',
    }),
  );

  ctx.picker.open();
  ctx.picker.applyKey(Buffer.from(KEYS.enter));
  ctx.picker.applyKey(Buffer.from(KEYS.down));
  ctx.picker.applyKey(Buffer.from(KEYS.enter));

  expect(ctx.daemon.collectSent('agents.list')).toStrictEqual([{}]);
});

test('it returns esc from the directory step to the agent step when more than one agent is installed', async () => {
  using ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({
      claudeBin: process.execPath,
      grokBin: process.execPath,
      codexBin: 'no-codex',
    }),
  );

  ctx.picker.open();
  ctx.picker.applyKey(Buffer.from(KEYS.enter));

  await ctx.daemon.answer('agents.list', {
    targets: [
      {
        id: 'local',
        provider: 'local-pty',
        available: true,
        default: true,
        capabilities: { transfer: true, run: true },
      },
    ],
    sources: [{ id: 'dirs', label: 'directory on the daemon host', kind: 'path' }],
  });

  await ctx.daemon.answer('sources.list', { source: 'dirs', scope: null, candidates: [] });

  ctx.terminal.reset();
  ctx.picker.applyKey(Buffer.from(KEYS.esc));

  expect(ctx.terminal.getText()).toInclude('spawn: agent');
  expect(ctx.counts.exits).toBe(0);
});

test('it leaves the flow on esc from the directory step when one agent is installed', async () => {
  using ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ claudeBin: process.execPath, grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  ctx.picker.open();

  await ctx.daemon.answer('agents.list', {
    targets: [
      {
        id: 'local',
        provider: 'local-pty',
        available: true,
        default: true,
        capabilities: { transfer: true, run: true },
      },
    ],
    sources: [{ id: 'dirs', label: 'directory on the daemon host', kind: 'path' }],
  });

  await ctx.daemon.answer('sources.list', { source: 'dirs', scope: null, candidates: [] });

  ctx.picker.applyKey(Buffer.from(KEYS.esc));

  expect(ctx.counts.exits).toBe(1);
});

test('it opens the name step after the directory when one agent and one target leave no choice', async () => {
  using ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ claudeBin: process.execPath, grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  ctx.picker.open();

  await ctx.daemon.answer('agents.list', {
    targets: [
      {
        id: 'local',
        provider: 'local-pty',
        available: true,
        default: true,
        capabilities: { transfer: true, run: true },
      },
    ],
    sources: [{ id: 'dirs', label: 'directory on the daemon host', kind: 'path' }],
  });

  await ctx.daemon.answer('sources.list', { source: 'dirs', scope: null, candidates: [] });

  ctx.terminal.reset();
  ctx.picker.applyKey(Buffer.from(KEYS.enter));

  const shown = ctx.terminal.getText();

  expect(shown).toInclude('spawn: name');
  expect(shown).not.toInclude('spawn: target');
});

test('it returns esc from the name step to the directory step when one target left no choice', async () => {
  using ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ claudeBin: process.execPath, grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  ctx.picker.open();

  await ctx.daemon.answer('agents.list', {
    targets: [
      {
        id: 'local',
        provider: 'local-pty',
        available: true,
        default: true,
        capabilities: { transfer: true, run: true },
      },
    ],
    sources: [{ id: 'dirs', label: 'directory on the daemon host', kind: 'path' }],
  });

  await ctx.daemon.answer('sources.list', { source: 'dirs', scope: null, candidates: [] });

  ctx.picker.applyKey(Buffer.from(KEYS.enter));
  ctx.terminal.reset();
  ctx.picker.applyKey(Buffer.from(KEYS.esc));

  expect(ctx.terminal.getText()).toInclude('spawn: directory on the daemon host');
  expect(ctx.counts.exits).toBe(0);
});

test('it lists a git source for the one target without a key when one agent and one target leave no choice', async () => {
  using ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ claudeBin: process.execPath, grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  ctx.picker.open();

  await ctx.daemon.answer('agents.list', {
    targets: [
      {
        id: 'local',
        provider: 'local-pty',
        available: true,
        default: true,
        capabilities: { transfer: true, run: true },
      },
    ],
    sources: [{ id: 'fake', label: 'fake repository', kind: 'git' }],
  });

  expect(ctx.daemon.collectSent('sources.list')).toStrictEqual([
    { source: 'fake', target: 'local' },
  ]);
});

test('it leaves the flow on esc from a git source when one agent and one target leave no choice', async () => {
  using ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ claudeBin: process.execPath, grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  ctx.picker.open();

  await ctx.daemon.answer('agents.list', {
    targets: [
      {
        id: 'local',
        provider: 'local-pty',
        available: true,
        default: true,
        capabilities: { transfer: true, run: true },
      },
    ],
    sources: [{ id: 'fake', label: 'fake repository', kind: 'git' }],
  });

  await ctx.daemon.answer('sources.list', { source: 'fake', scope: null, candidates: [] });

  ctx.picker.applyKey(Buffer.from(KEYS.esc));

  expect(ctx.counts.exits).toBe(1);
});

test('it takes the one available target for a directory when the other is unavailable', async () => {
  using ctx = setupTest({ ptyRows: 24 });

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ claudeBin: process.execPath, grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  ctx.picker.open();

  await ctx.daemon.answer('agents.list', {
    targets: [
      {
        id: 'local',
        provider: 'local-pty',
        available: true,
        default: true,
        capabilities: { transfer: true, run: true },
      },
      {
        id: 'box',
        provider: 'imp',
        available: false,
        default: false,
        capabilities: { transfer: true, run: true },
      },
    ],
    sources: [{ id: 'dirs', label: 'directory on the daemon host', kind: 'path' }],
  });

  await ctx.daemon.answer('sources.list', { source: 'dirs', scope: null, candidates: [] });

  ctx.picker.applyKey(Buffer.from(KEYS.enter));
  ctx.picker.applyKey(Buffer.from(KEYS.enter));
  ctx.picker.applyKey(Buffer.from(KEYS.enter));

  expect(ctx.daemon.collectSent('session.spawn')).toStrictEqual([
    {
      cwd: ctx.cwd,
      name: '',
      prompt: '',
      cols: expect.any(Number),
      rows: 24,
      agent: 'claude',
      target: 'local',
    },
  ]);
});

test('it takes the one target that takes a workspace for a repository', async () => {
  using ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ claudeBin: process.execPath, grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  ctx.picker.open();

  await ctx.daemon.answer('agents.list', {
    targets: [
      { id: 'local', provider: 'local-pty', available: true, default: true, capabilities: {} },
      {
        id: 'box',
        provider: 'imp',
        available: true,
        default: false,
        capabilities: { transfer: true, run: true },
      },
    ],
    sources: [{ id: 'fake', label: 'fake repository', kind: 'git' }],
  });

  expect(ctx.daemon.collectSent('sources.list')).toStrictEqual([{ source: 'fake', target: 'box' }]);
});

test('it offers both targets for a directory when only one takes a workspace', async () => {
  using ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ claudeBin: process.execPath, grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  ctx.picker.open();

  await ctx.daemon.answer('agents.list', {
    targets: [
      { id: 'local', provider: 'local-pty', available: true, default: true, capabilities: {} },
      {
        id: 'box',
        provider: 'imp',
        available: true,
        default: false,
        capabilities: { transfer: true, run: true },
      },
    ],
    sources: [{ id: 'dirs', label: 'directory on the daemon host', kind: 'path' }],
  });

  await ctx.daemon.answer('sources.list', { source: 'dirs', scope: null, candidates: [] });

  ctx.terminal.reset();
  ctx.picker.applyKey(Buffer.from(KEYS.enter));

  expect(ctx.terminal.getText()).toInclude('spawn: target');
});

test('it shows why no target can run a directory when the one target is unavailable', async () => {
  using ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ claudeBin: process.execPath, grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  ctx.picker.open();

  await ctx.daemon.answer('agents.list', {
    targets: [
      {
        id: 'box',
        provider: 'imp',
        available: false,
        default: false,
        capabilities: { transfer: true, run: true },
      },
    ],
    sources: [{ id: 'dirs', label: 'directory on the daemon host', kind: 'path' }],
  });

  await ctx.daemon.answer('sources.list', { source: 'dirs', scope: null, candidates: [] });

  ctx.terminal.reset();
  ctx.picker.applyKey(Buffer.from(KEYS.enter));

  const shown = ctx.terminal.getText();

  expect(shown).toInclude('spawn: target');
  expect(shown).toInclude('none of these targets can run');
});

test('it shows why no target can run a repository when none takes a workspace', async () => {
  using ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ claudeBin: process.execPath, grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  ctx.picker.open();

  await ctx.daemon.answer('agents.list', {
    targets: [
      { id: 'local', provider: 'local-pty', available: true, default: true, capabilities: {} },
    ],
    sources: [{ id: 'fake', label: 'fake repository', kind: 'git' }],
  });

  expect(ctx.terminal.getText()).toInclude('none of these targets can run the repository');
  expect(ctx.daemon.collectSent('sources.list')).toStrictEqual([]);
});

test('it shows why no target can run an agent whose broker no target reaches', async () => {
  using ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ claudeBin: process.execPath, grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  ctx.picker.open();

  await ctx.daemon.answer('agents.list', {
    agents: [{ id: 'claude', brokerAuth: true }],
    targets: [
      {
        id: 'local',
        provider: 'local-pty',
        available: true,
        default: true,
        capabilities: { transfer: true, run: true },
      },
    ],
    sources: [{ id: 'dirs', label: 'directory on the daemon host', kind: 'path' }],
  });

  await ctx.daemon.answer('sources.list', { source: 'dirs', scope: null, candidates: [] });

  ctx.terminal.reset();
  ctx.picker.applyKey(Buffer.from(KEYS.enter));

  expect(ctx.terminal.getText()).toInclude('no target reaches the credential broker claude needs');
  expect(ctx.daemon.collectSent('session.spawn')).toStrictEqual([]);
});

test('it shows why no target can adopt when none runs on the daemon host', async () => {
  using ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ claudeBin: process.execPath, grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  ctx.picker.open(true);

  await ctx.daemon.answer('agents.list', {
    targets: [
      {
        id: 'box',
        provider: 'imp',
        available: true,
        default: false,
        capabilities: { transfer: true, run: true },
      },
    ],
    sources: [{ id: 'dirs', label: 'directory on the daemon host', kind: 'path' }],
  });

  await ctx.daemon.answer('sources.list', { source: 'dirs', scope: null, candidates: [] });

  ctx.terminal.reset();
  ctx.picker.applyKey(Buffer.from(KEYS.enter));

  expect(ctx.terminal.getText()).toInclude('no target on this host can adopt a session');
  expect(ctx.daemon.collectSent('session.spawn')).toStrictEqual([]);
});

test('it returns esc from a target step with no usable target to the directory step', async () => {
  using ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ claudeBin: process.execPath, grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  ctx.picker.open();

  await ctx.daemon.answer('agents.list', {
    targets: [
      {
        id: 'box',
        provider: 'imp',
        available: false,
        default: false,
        capabilities: { transfer: true, run: true },
      },
    ],
    sources: [{ id: 'dirs', label: 'directory on the daemon host', kind: 'path' }],
  });

  await ctx.daemon.answer('sources.list', { source: 'dirs', scope: null, candidates: [] });

  ctx.picker.applyKey(Buffer.from(KEYS.enter));
  ctx.terminal.reset();
  ctx.picker.applyKey(Buffer.from(KEYS.esc));

  expect(ctx.terminal.getText()).toInclude('spawn: directory on the daemon host');
  expect(ctx.counts.exits).toBe(0);
});

test('it drops the target and source answer of a flow that was left and opened again', async () => {
  using ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ claudeBin: process.execPath, grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  ctx.picker.open();
  ctx.picker.applyKey(Buffer.from(KEYS.esc));
  ctx.picker.open();

  const renders = ctx.counts.renders;

  await ctx.daemon.answerOldest('agents.list', {
    targets: [
      {
        id: 'local',
        provider: 'local-pty',
        available: true,
        default: true,
        capabilities: { transfer: true, run: true },
      },
    ],
    sources: [{ id: 'dirs', label: 'directory on the daemon host', kind: 'path' }],
  });

  expect(ctx.daemon.collectSent('agents.list')).toStrictEqual([{}, {}]);
  expect(ctx.daemon.collectSent('sources.list')).toStrictEqual([]);
  expect(ctx.counts.renders).toBe(renders);
  expect(ctx.dropped).toStrictEqual(['targets and sources']);
});

test('it returns esc from a git source to the agent step when one target left no choice', async () => {
  using ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({
      claudeBin: process.execPath,
      grokBin: process.execPath,
      codexBin: 'no-codex',
    }),
  );

  ctx.picker.open();
  ctx.picker.applyKey(Buffer.from(KEYS.enter));

  await ctx.daemon.answer('agents.list', {
    targets: [
      {
        id: 'local',
        provider: 'local-pty',
        available: true,
        default: true,
        capabilities: { transfer: true, run: true },
      },
    ],
    sources: [
      { id: 'fake', label: 'fake repository', kind: 'git' },
      { id: 'dirs', label: 'directory on the daemon host', kind: 'path' },
    ],
  });

  await ctx.daemon.answer('sources.list', { source: 'fake', scope: null, candidates: [] });

  ctx.terminal.reset();
  ctx.picker.applyKey(Buffer.from(KEYS.esc));

  expect(ctx.terminal.getText()).toInclude('spawn: agent');
  expect(ctx.counts.exits).toBe(0);
});
