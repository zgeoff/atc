import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DAEMON_FEATURES } from '../protocol/daemon-features';
import type { DaemonFeature } from '../protocol/daemon-features';
import { buildStubDaemonRequests } from '../test-utils/build-stub-daemon-requests';
import { KEYS } from '../test-utils/keys';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { SpawnPicker } from './spawn-picker';

/**
 * A spawn picker reading its config from `configPath` in a fresh temp
 * directory, drawing into `screen`, and talking to a daemon that answers
 * only when a test says so. `counts` records each draw, each return to the
 * screen the flow came from, each attach, and each answer the picker
 * dropped; the daemon serves every feature. Disposal removes the
 * directory.
 */
function setupTest() {
  const tmp = setupTempDir('atc-spawn-picker-');
  const screen: string[] = [];
  const counts = { renders: 0, exits: 0, attached: 0, drops: 0 };

  // A current daemon serves every feature.
  const features = new Set<DaemonFeature>(DAEMON_FEATURES);

  const daemon = buildStubDaemonRequests({
    countReactions: () => counts.renders + counts.exits + counts.attached + counts.drops,
  });

  const configPath = join(tmp.dir, 'config.json');

  const picker = new SpawnPicker<{ readonly id: string }>({
    sendRequest: (m, p) => daemon.sendRequest(m, p),
    ptyRows: () => 24,
    hasDaemonFeature: (feature) => features.has(feature),
    isLeaderKey: (buf) => buf.toString() === KEYS.ctrlRightBracket,
    getLastUsedAgent: () => 'claude',
    scheduleStatus: () => {
      counts.renders += 1;
    },
    toBase: () => {
      counts.exits += 1;
    },
    attach: () => {
      counts.attached += 1;

      return Promise.resolve();
    },
    toMirrorSession: () => ({ id: 's-1' }),
    upsertMirror: () => {},
    write: (chunk) => {
      screen.push(chunk);
    },

    // The picker runs from the filesystem root, so typed text never
    // fuzzy-matches the directory it lists first.
    cwd: '/',

    configPath,
    onDropAnswer: () => {
      counts.drops += 1;
    },
  });

  return {
    picker,
    daemon,
    screen,
    counts,
    configPath,
    [Symbol.dispose]: tmp[Symbol.dispose],
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
  expect(ctx.counts.drops).toBe(1);
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
  expect(ctx.counts.drops).toBe(1);
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
  expect(ctx.counts.drops).toBe(1);
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
  expect(ctx.counts.drops).toBe(1);
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
  expect(ctx.counts.drops).toBe(1);
  expect(ctx.daemon.collectSent('sources.list')).toHaveLength(1);
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
  expect(ctx.counts.drops).toBe(1);
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
  expect(ctx.counts.drops).toBe(1);
  expect(ctx.counts.attached).toBe(0);
});

test('it materializes a directory on the one target when that target is remote', async () => {
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

  expect(ctx.daemon.collectSent('session.spawn')).toStrictEqual([
    {
      cwd: '/',
      name: '',
      prompt: '',
      cols: expect.any(Number),
      rows: 24,
      agent: 'claude',
      target: 'box',
      workspace: { kind: 'path', path: '/' },
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

  ctx.screen.length = 0;

  ctx.picker.applyKey(Buffer.from(KEYS.enter));

  expect(ctx.screen.join('')).toInclude(
    'dest    box:~/.local/share/atc/workspaces/app-main-aaaaaaa',
  );
});

test('it spawns a repository on a remote target with no destination typed and leaves the directory to the daemon', async () => {
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
      cwd: '/',
      name: '',
      prompt: '',
      cols: expect.any(Number),
      rows: 24,
      agent: 'claude',
      target: 'box',
      workspace: { kind: 'path', path: '/' },
    },
  ]);
});

test('it shows the refusal of a remote target without a workspace root when the daemon cannot pick the directory', async () => {
  using tmp = setupTempDir('atc-spawn-picker-');

  const screen: string[] = [];
  const counts = { renders: 0, exits: 0, attached: 0, drops: 0 };

  // A daemon that serves every feature but picking the directory itself.
  const features = new Set<DaemonFeature>(
    DAEMON_FEATURES.filter((feature) => feature !== 'spawn.workspace.autoDir'),
  );

  const daemon = buildStubDaemonRequests({
    countReactions: () => counts.renders + counts.exits + counts.attached + counts.drops,
  });

  const picker = new SpawnPicker<{ readonly id: string }>({
    sendRequest: (m, p) => daemon.sendRequest(m, p),
    ptyRows: () => 24,
    hasDaemonFeature: (feature) => features.has(feature),
    isLeaderKey: (buf) => buf.toString() === KEYS.ctrlRightBracket,
    getLastUsedAgent: () => 'claude',
    scheduleStatus: () => {
      counts.renders += 1;
    },
    toBase: () => {
      counts.exits += 1;
    },
    attach: () => {
      counts.attached += 1;

      return Promise.resolve();
    },
    toMirrorSession: () => ({ id: 's-1' }),
    upsertMirror: () => {},
    write: (chunk) => {
      screen.push(chunk);
    },

    // The picker runs from the filesystem root, so typed text never
    // fuzzy-matches the directory it lists first.
    cwd: '/',

    configPath: join(tmp.dir, 'config.json'),
    onDropAnswer: () => {
      counts.drops += 1;
    },
  });

  writeFileSync(
    join(tmp.dir, 'config.json'),
    JSON.stringify({ claudeBin: process.execPath, grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  picker.open();

  await daemon.answer('agents.list', {
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

  await daemon.answer('sources.list', { source: 'fake', scope: null, candidates: [] });

  picker.applyKey(Buffer.from('https://example.com/app.git'));
  picker.applyKey(Buffer.from(KEYS.enter));

  await daemon.answer('git.probe', {
    url: 'https://example.com/app.git',
    head: 'main',
    refs: [{ name: 'main', kind: 'branch', sha: 'a'.repeat(40) }],
    resolved: null,
  });

  screen.length = 0;

  picker.applyKey(Buffer.from(KEYS.enter));

  expect(screen.join('')).toInclude('set workspaces.targets.box in config.json');
});

test('it sends no spawn to a remote target without a workspace root when the daemon cannot pick the directory', async () => {
  using tmp = setupTempDir('atc-spawn-picker-');

  const screen: string[] = [];
  const counts = { renders: 0, exits: 0, attached: 0, drops: 0 };

  // A daemon that serves every feature but picking the directory itself.
  const features = new Set<DaemonFeature>(
    DAEMON_FEATURES.filter((feature) => feature !== 'spawn.workspace.autoDir'),
  );

  const daemon = buildStubDaemonRequests({
    countReactions: () => counts.renders + counts.exits + counts.attached + counts.drops,
  });

  const picker = new SpawnPicker<{ readonly id: string }>({
    sendRequest: (m, p) => daemon.sendRequest(m, p),
    ptyRows: () => 24,
    hasDaemonFeature: (feature) => features.has(feature),
    isLeaderKey: (buf) => buf.toString() === KEYS.ctrlRightBracket,
    getLastUsedAgent: () => 'claude',
    scheduleStatus: () => {
      counts.renders += 1;
    },
    toBase: () => {
      counts.exits += 1;
    },
    attach: () => {
      counts.attached += 1;

      return Promise.resolve();
    },
    toMirrorSession: () => ({ id: 's-1' }),
    upsertMirror: () => {},
    write: (chunk) => {
      screen.push(chunk);
    },

    // The picker runs from the filesystem root, so typed text never
    // fuzzy-matches the directory it lists first.
    cwd: '/',

    configPath: join(tmp.dir, 'config.json'),
    onDropAnswer: () => {
      counts.drops += 1;
    },
  });

  writeFileSync(
    join(tmp.dir, 'config.json'),
    JSON.stringify({ claudeBin: process.execPath, grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  picker.open();

  await daemon.answer('agents.list', {
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

  await daemon.answer('sources.list', { source: 'fake', scope: null, candidates: [] });

  picker.applyKey(Buffer.from('https://example.com/app.git'));
  picker.applyKey(Buffer.from(KEYS.enter));

  await daemon.answer('git.probe', {
    url: 'https://example.com/app.git',
    head: 'main',
    refs: [{ name: 'main', kind: 'branch', sha: 'a'.repeat(40) }],
    resolved: null,
  });

  picker.applyKey(Buffer.from(KEYS.enter));
  picker.applyKey(Buffer.from(KEYS.enter));
  picker.applyKey(Buffer.from(KEYS.enter));
  picker.applyKey(Buffer.from(KEYS.enter));

  expect(daemon.collectSent('session.spawn')).toStrictEqual([]);
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

  ctx.screen.length = 0;

  await ctx.daemon.answer('session.spawn', {
    session: { id: 's-1' },
    warnings: [
      'cloned commit 0123456789ab; left 12 uncommitted or untracked paths behind in /home/me/src/a-project-with-a-long-name',
    ],
  });

  const shown = ctx.screen.join('');

  expect(shown).toInclude('/home/me/src/a-project-with-a-long-name');
  expect(shown).toInclude('0123456789ab');
  expect(shown).not.toInclude('…');
});

test('it leaves a session whose workspace left changes behind running when esc returns', async () => {
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
      'cloned commit 0123456789ab; left 1 uncommitted or untracked path behind in /src/app',
    ],
  });

  ctx.picker.applyKey(Buffer.from(KEYS.esc));

  expect(ctx.counts.attached).toBe(0);
  expect(ctx.counts.exits).toBe(1);
  expect(ctx.daemon.collectSent('session.spawn')).toHaveLength(1);
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

  expect(ctx.daemon.collectSent('session.spawn')).toStrictEqual([
    {
      cwd: '/',
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
      cwd: '/',
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
      cwd: '/',
      name: '',
      prompt: '',
      cols: expect.any(Number),
      rows: 24,
      agent: 'claude',
      target: 'box',
      workspace: { kind: 'path', path: '/' },
    },
  ]);
});

test('it offers an agent that takes no broker credential every target', async () => {
  using ctx = setupTest();

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
      cwd: '/',
      name: '',
      prompt: '',
      cols: expect.any(Number),
      rows: 24,
      agent: 'claude',
      target: 'local',
    },
  ]);
});

test('it offers an agent that takes the broker credential only where a broker is every target', async () => {
  using ctx = setupTest();

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
      cwd: '/',
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

  expect(ctx.daemon.collectSent('session.spawn').map((p) => p['target'])).toStrictEqual([
    'box',
    'local',
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

  expect(ctx.daemon.collectSent('sources.list').filter((p) => p['source'] === 'fake')).toHaveLength(
    2,
  );
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

  expect(ctx.screen.join('')).toInclude('no agent CLI found');
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

  expect(ctx.daemon.collectSent('agents.list')).toHaveLength(1);
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

  ctx.screen.length = 0;

  ctx.picker.applyKey(Buffer.from(KEYS.esc));

  expect(ctx.screen.join('')).toInclude('spawn: agent');
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

  ctx.screen.length = 0;

  ctx.picker.applyKey(Buffer.from(KEYS.enter));

  const shown = ctx.screen.join('');

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

  ctx.screen.length = 0;

  ctx.picker.applyKey(Buffer.from(KEYS.esc));

  expect(ctx.screen.join('')).toInclude('spawn: directory on the daemon host');
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
      cwd: '/',
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

  ctx.screen.length = 0;

  ctx.picker.applyKey(Buffer.from(KEYS.enter));

  expect(ctx.screen.join('')).toInclude('spawn: target');
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

  ctx.screen.length = 0;

  ctx.picker.applyKey(Buffer.from(KEYS.enter));

  const shown = ctx.screen.join('');

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

  expect(ctx.screen.join('')).toInclude('none of these targets can run the repository');
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

  ctx.screen.length = 0;

  ctx.picker.applyKey(Buffer.from(KEYS.enter));

  expect(ctx.screen.join('')).toInclude('no target reaches the credential broker claude needs');
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

  ctx.screen.length = 0;

  ctx.picker.applyKey(Buffer.from(KEYS.enter));

  expect(ctx.screen.join('')).toInclude('no target on this host can adopt a session');
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

  ctx.screen.length = 0;

  ctx.picker.applyKey(Buffer.from(KEYS.esc));

  expect(ctx.screen.join('')).toInclude('spawn: directory on the daemon host');
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

  expect(ctx.daemon.collectSent('agents.list')).toHaveLength(2);
  expect(ctx.daemon.collectSent('sources.list')).toStrictEqual([]);
  expect(ctx.counts.renders).toBe(renders);
  expect(ctx.counts.drops).toBe(1);
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

  ctx.screen.length = 0;

  ctx.picker.applyKey(Buffer.from(KEYS.esc));

  expect(ctx.screen.join('')).toInclude('spawn: agent');
  expect(ctx.counts.exits).toBe(0);
});
