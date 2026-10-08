import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildMockSessionDescriptor } from '../test-utils/build-mock-session-descriptor';
import { buildStubDaemonRequests } from '../test-utils/build-stub-daemon-requests';
import { buildStubPickerHost } from '../test-utils/build-stub-picker-host';
import { buildStubTerminal } from '../test-utils/build-stub-terminal';
import { KEYS } from '../test-utils/keys';
import { SpawnPicker } from './spawn-picker';
import { toMirrorSession } from './to-mirror-session';

/**
 * What a spawn picker needs besides its scenario: a config at `configPath`
 * in a fresh temp directory, which is also the client's own directory
 * `cwd`, a stub `terminal` it draws into, and a daemon that answers only
 * when a test says so. `deps` wires them for the picker's constructor.
 * `counts` records each draw, each return to the screen the flow came
 * from, each attach, and each answer the picker dropped, and `dropped`
 * holds the kind of each dropped answer in order.
 */
function setupTest() {
  // Typed text fuzzy-filters the directories the directory step lists, the
  // client's own first, by every character in order. The temp root sits
  // directly under /tmp, whatever TMPDIR holds, so the only separators in
  // its path come before any letter a filter such as `acme/` needs.
  const cwd = mkdtempSync('/tmp/atc-spawn-picker-');

  onTestFinished(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  const host = buildStubPickerHost();
  const terminal = buildStubTerminal();
  const daemon = buildStubDaemonRequests({ countReactions: host.countReactions });
  const configPath = join(cwd, 'config.json');

  const deps = {
    sendRequest: (m: string, p?: Readonly<Record<string, unknown>>) => daemon.sendRequest(m, p),
    isLeaderKey: (buf: Buffer) => buf.toString() === KEYS.ctrlRightBracket,
    scheduleStatus: host.scheduleStatus,
    toBase: host.toBase,
    attach: host.attach,
    toMirrorSession,
    upsertMirror: () => {},
    write: terminal.write,
    cwd,
    configPath,
    onDropAnswer: host.onDropAnswer,
  };

  return {
    deps,
    daemon,
    terminal,
    counts: host.counts,
    dropped: host.dropped,
    cwd,
    configPath,
  };
}

test('it drops the target and source answer that arrives after esc leaves the agent step', async () => {
  const ctx = setupTest();

  const picker = new SpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    hasDaemonFeature: () => true,
    getLastUsedAgent: () => 'claude',
  });

  writeFileSync(
    ctx.configPath,
    JSON.stringify({
      claudeBin: process.execPath,
      grokBin: process.execPath,
      codexBin: 'no-codex',
    }),
  );

  picker.open();
  picker.applyKey(Buffer.from(KEYS.enter));
  picker.applyKey(Buffer.from(KEYS.esc));

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
  const ctx = setupTest();

  const picker = new SpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    hasDaemonFeature: () => true,
    getLastUsedAgent: () => 'claude',
  });

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ claudeBin: process.execPath, grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  picker.open();

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

  picker.applyKey(Buffer.from(KEYS.esc));

  const renders = ctx.counts.renders;

  await ctx.daemon.answer('dirs.list', { dirs: ['/srv/one'] });

  expect(ctx.counts.exits).toBe(1);
  expect(ctx.counts.renders).toBe(renders);
  expect(ctx.dropped).toStrictEqual(['local directory listing']);
});

test('it drops a git listing that arrives after the leader leaves the flow', async () => {
  const ctx = setupTest();

  const picker = new SpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    hasDaemonFeature: () => true,
    getLastUsedAgent: () => 'claude',
  });

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ claudeBin: process.execPath, grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  picker.open();

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

  picker.applyKey(Buffer.from(KEYS.ctrlRightBracket));

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
  const ctx = setupTest();

  const picker = new SpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    hasDaemonFeature: () => true,
    getLastUsedAgent: () => 'claude',
  });

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ claudeBin: process.execPath, grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  picker.open();

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

  picker.applyKey(Buffer.from(KEYS.ctrlRightBracket));

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
  const ctx = setupTest();

  const picker = new SpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    hasDaemonFeature: () => true,
    getLastUsedAgent: () => 'claude',
  });

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ claudeBin: process.execPath, grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  picker.open();

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

  picker.applyKey(Buffer.from('acme/'));
  picker.applyKey(Buffer.from(KEYS.enter));
  picker.applyKey(Buffer.from(KEYS.ctrlRightBracket));

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
  const ctx = setupTest();

  const picker = new SpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    hasDaemonFeature: () => true,
    getLastUsedAgent: () => 'claude',
  });

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ claudeBin: process.execPath, grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  picker.open();

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

  picker.applyKey(Buffer.from('https://example.com/app.git'));
  picker.applyKey(Buffer.from(KEYS.enter));
  picker.applyKey(Buffer.from(KEYS.esc));
  picker.applyKey(Buffer.from(KEYS.ctrlRightBracket));

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
  const ctx = setupTest();

  const picker = new SpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    hasDaemonFeature: () => true,
    getLastUsedAgent: () => 'claude',
  });

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ claudeBin: process.execPath, grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  picker.open();

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

  picker.applyKey(Buffer.from(KEYS.enter));
  picker.applyKey(Buffer.from(KEYS.enter));
  picker.applyKey(Buffer.from(KEYS.enter));
  picker.applyKey(Buffer.from(KEYS.esc));

  const renders = ctx.counts.renders;

  await ctx.daemon.answer('session.spawn', { session: buildMockSessionDescriptor() });

  expect(ctx.counts.exits).toBe(1);
  expect(ctx.counts.renders).toBe(renders);
  expect(ctx.dropped).toStrictEqual(['spawn']);
  expect(ctx.counts.attached).toBe(0);
});

test('it materializes a directory on the one target when that target is remote', async () => {
  const ctx = setupTest();

  const picker = new SpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    hasDaemonFeature: () => true,
    getLastUsedAgent: () => 'claude',
  });

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ claudeBin: process.execPath, grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  picker.open();

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

  picker.applyKey(Buffer.from(KEYS.enter));
  picker.applyKey(Buffer.from(KEYS.enter));
  picker.applyKey(Buffer.from(KEYS.enter));

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
  const ctx = setupTest();

  const picker = new SpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    hasDaemonFeature: () => true,
    getLastUsedAgent: () => 'claude',
  });

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ claudeBin: process.execPath, grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  picker.open();

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

  picker.applyKey(Buffer.from('https://example.com/app.git'));
  picker.applyKey(Buffer.from(KEYS.enter));

  await ctx.daemon.answer('git.probe', {
    url: 'https://example.com/app.git',
    head: 'main',
    refs: [{ name: 'main', kind: 'branch', sha: 'a'.repeat(40) }],
    resolved: null,
  });

  const mark = ctx.terminal.mark();

  picker.applyKey(Buffer.from(KEYS.enter));

  expect(ctx.terminal.getTextSince(mark)).toInclude(
    'dest    box:~/.local/share/atc/workspaces/app-main-aaaaaaa',
  );
});

test('it spawns a repository on a remote target with no destination typed and leaves the directory to the daemon', async () => {
  const ctx = setupTest();

  const picker = new SpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    hasDaemonFeature: () => true,
    getLastUsedAgent: () => 'claude',
  });

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ claudeBin: process.execPath, grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  picker.open();

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

  picker.applyKey(Buffer.from('https://example.com/app.git'));
  picker.applyKey(Buffer.from(KEYS.enter));

  await ctx.daemon.answer('git.probe', {
    url: 'https://example.com/app.git',
    head: 'main',
    refs: [{ name: 'main', kind: 'branch', sha: 'a'.repeat(40) }],
    resolved: null,
  });

  picker.applyKey(Buffer.from(KEYS.enter));
  picker.applyKey(Buffer.from(KEYS.enter));
  picker.applyKey(Buffer.from(KEYS.enter));
  picker.applyKey(Buffer.from(KEYS.enter));

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
  const ctx = setupTest();

  const picker = new SpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    hasDaemonFeature: () => true,
    getLastUsedAgent: () => 'claude',
  });

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ claudeBin: process.execPath, grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  picker.open();

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

  picker.applyKey(Buffer.from('https://example.com/app.git'));
  picker.applyKey(Buffer.from(KEYS.enter));

  await ctx.daemon.answer('git.probe', {
    url: 'https://example.com/app.git',
    head: 'main',
    refs: [{ name: 'main', kind: 'branch', sha: 'a'.repeat(40) }],
    resolved: null,
  });

  picker.applyKey(Buffer.from(KEYS.enter));
  picker.applyKey(Buffer.from(KEYS.ctrlRightBracket));
  picker.open();

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

  picker.applyKey(Buffer.from(KEYS.enter));
  picker.applyKey(Buffer.from(KEYS.enter));
  picker.applyKey(Buffer.from(KEYS.enter));

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
  const ctx = setupTest();

  // A daemon that serves every feature but picking the directory itself.
  const picker = new SpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    hasDaemonFeature: (feature) => feature !== 'spawn.workspace.autoDir',
    getLastUsedAgent: () => 'claude',
  });

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ claudeBin: process.execPath, grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  picker.open();

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

  picker.applyKey(Buffer.from('https://example.com/app.git'));
  picker.applyKey(Buffer.from(KEYS.enter));

  await ctx.daemon.answer('git.probe', {
    url: 'https://example.com/app.git',
    head: 'main',
    refs: [{ name: 'main', kind: 'branch', sha: 'a'.repeat(40) }],
    resolved: null,
  });

  const mark = ctx.terminal.mark();

  picker.applyKey(Buffer.from(KEYS.enter));

  expect(ctx.terminal.getTextSince(mark)).toInclude('set workspaces.targets.box in config.json');
});

test('it sends no spawn to a remote target without a workspace root when the daemon cannot pick the directory', async () => {
  const ctx = setupTest();

  // A daemon that serves every feature but picking the directory itself.
  const picker = new SpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    hasDaemonFeature: (feature) => feature !== 'spawn.workspace.autoDir',
    getLastUsedAgent: () => 'claude',
  });

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ claudeBin: process.execPath, grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  picker.open();

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

  picker.applyKey(Buffer.from('https://example.com/app.git'));
  picker.applyKey(Buffer.from(KEYS.enter));

  await ctx.daemon.answer('git.probe', {
    url: 'https://example.com/app.git',
    head: 'main',
    refs: [{ name: 'main', kind: 'branch', sha: 'a'.repeat(40) }],
    resolved: null,
  });

  picker.applyKey(Buffer.from(KEYS.enter));
  picker.applyKey(Buffer.from(KEYS.enter));
  picker.applyKey(Buffer.from(KEYS.enter));
  picker.applyKey(Buffer.from(KEYS.enter));

  expect(ctx.daemon.collectSent('session.spawn')).toStrictEqual([]);
});

test('it holds a session whose workspace left changes behind instead of attaching it', async () => {
  const ctx = setupTest();

  const picker = new SpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    hasDaemonFeature: () => true,
    getLastUsedAgent: () => 'claude',
  });

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ claudeBin: process.execPath, grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  picker.open();

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

  picker.applyKey(Buffer.from(KEYS.enter));
  picker.applyKey(Buffer.from(KEYS.enter));
  picker.applyKey(Buffer.from(KEYS.enter));

  await ctx.daemon.answer('session.spawn', {
    session: buildMockSessionDescriptor(),
    warnings: [
      'cloned commit 0123456789ab; left 2 uncommitted or untracked paths behind in /src/app',
    ],
  });

  expect(ctx.counts.attached).toBe(0);
  expect(ctx.counts.exits).toBe(0);
});

test('it attaches a held session whose workspace left changes behind on enter', async () => {
  const ctx = setupTest();

  const picker = new SpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    hasDaemonFeature: () => true,
    getLastUsedAgent: () => 'claude',
  });

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ claudeBin: process.execPath, grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  picker.open();

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

  picker.applyKey(Buffer.from(KEYS.enter));
  picker.applyKey(Buffer.from(KEYS.enter));
  picker.applyKey(Buffer.from(KEYS.enter));

  await ctx.daemon.answer('session.spawn', {
    session: buildMockSessionDescriptor(),
    warnings: [
      'cloned commit 0123456789ab; left 2 uncommitted or untracked paths behind in /src/app',
    ],
  });

  picker.applyKey(Buffer.from(KEYS.enter));

  expect(ctx.counts.attached).toBe(1);
  expect(ctx.counts.exits).toBe(0);
});

test('it shows the whole note of a workspace that left changes behind, wrapped to the picker', async () => {
  const ctx = setupTest();

  const picker = new SpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    hasDaemonFeature: () => true,
    getLastUsedAgent: () => 'claude',
  });

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ claudeBin: process.execPath, grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  picker.open();

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

  picker.applyKey(Buffer.from(KEYS.enter));
  picker.applyKey(Buffer.from(KEYS.enter));
  picker.applyKey(Buffer.from(KEYS.enter));

  const mark = ctx.terminal.mark();

  await ctx.daemon.answer('session.spawn', {
    session: buildMockSessionDescriptor(),
    warnings: [
      'cloned commit 0123456789ab; left 12 uncommitted or untracked paths behind in /home/me/src/a-project-with-a-long-name',
    ],
  });

  const shown = ctx.terminal.getTextSince(mark);

  expect(shown).toInclude('/home/me/src/a-project-with-a-long-name');
  expect(shown).toInclude('0123456789ab');
  expect(shown).not.toInclude('…');
});

test('it leaves a session whose workspace left changes behind running when esc returns', async () => {
  const ctx = setupTest();

  const picker = new SpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    hasDaemonFeature: () => true,
    getLastUsedAgent: () => 'claude',
  });

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ claudeBin: process.execPath, grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  picker.open();

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

  picker.applyKey(Buffer.from(KEYS.enter));
  picker.applyKey(Buffer.from(KEYS.enter));
  picker.applyKey(Buffer.from(KEYS.enter));

  await ctx.daemon.answer('session.spawn', {
    session: buildMockSessionDescriptor(),
    warnings: [
      'cloned commit 0123456789ab; left 1 uncommitted or untracked path behind in /src/app',
    ],
  });

  picker.applyKey(Buffer.from(KEYS.esc));

  expect(ctx.counts.attached).toBe(0);
  expect(ctx.counts.exits).toBe(1);
  expect(ctx.daemon.collectSent('session.kill')).toStrictEqual([]);

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
  const ctx = setupTest();

  const picker = new SpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    hasDaemonFeature: () => true,
    getLastUsedAgent: () => 'claude',
  });

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ claudeBin: process.execPath, grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  picker.open();

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

  picker.applyKey(Buffer.from(KEYS.enter));
  picker.applyKey(Buffer.from(KEYS.enter));
  picker.applyKey(Buffer.from(KEYS.enter));

  await ctx.daemon.answer('session.spawn', { session: buildMockSessionDescriptor() });

  expect(ctx.counts.attached).toBe(1);
});

test('it runs a directory in place on the one target when that target is local', async () => {
  const ctx = setupTest();

  const picker = new SpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    hasDaemonFeature: () => true,
    getLastUsedAgent: () => 'claude',
  });

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ claudeBin: process.execPath, grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  picker.open();

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

  picker.applyKey(Buffer.from(KEYS.enter));
  picker.applyKey(Buffer.from(KEYS.enter));
  picker.applyKey(Buffer.from(KEYS.enter));

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
  const ctx = setupTest();

  const picker = new SpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    hasDaemonFeature: () => true,
    getLastUsedAgent: () => 'claude',
  });

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ claudeBin: process.execPath, grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  picker.open(true);

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

  picker.applyKey(Buffer.from(KEYS.enter));
  picker.applyKey(Buffer.from(KEYS.enter));

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
  const ctx = setupTest();

  const picker = new SpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    hasDaemonFeature: () => true,
    getLastUsedAgent: () => 'claude',
  });

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ claudeBin: process.execPath, grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  picker.open();

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

  picker.applyKey(Buffer.from(KEYS.enter));
  picker.applyKey(Buffer.from(KEYS.enter));
  picker.applyKey(Buffer.from(KEYS.enter));

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
  const ctx = setupTest();

  const picker = new SpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    hasDaemonFeature: () => true,
    getLastUsedAgent: () => 'claude',
  });

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ claudeBin: process.execPath, grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  picker.open();

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

  picker.applyKey(Buffer.from(KEYS.enter));
  picker.applyKey(Buffer.from(KEYS.enter));
  picker.applyKey(Buffer.from(KEYS.enter));
  picker.applyKey(Buffer.from(KEYS.enter));

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
  const ctx = setupTest();

  const picker = new SpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    hasDaemonFeature: () => true,
    getLastUsedAgent: () => 'claude',
  });

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ claudeBin: process.execPath, grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  picker.open();

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

  picker.applyKey(Buffer.from(KEYS.enter));
  picker.applyKey(Buffer.from(KEYS.enter));
  picker.applyKey(Buffer.from(KEYS.enter));
  picker.applyKey(Buffer.from(KEYS.enter));

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
  const ctx = setupTest();

  const picker = new SpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    hasDaemonFeature: () => true,
    getLastUsedAgent: () => 'claude',
  });

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ claudeBin: process.execPath, grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  picker.open();

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

  picker.applyKey(Buffer.from('acme/'));
  picker.applyKey(Buffer.from(KEYS.enter));

  await ctx.daemon.answer('sources.interpret', { kind: 'none' });
  await ctx.daemon.answer('sources.interpret', { kind: 'browse', scope: 'acme' });

  picker.applyKey(Buffer.from(KEYS.down));
  picker.applyKey(Buffer.from(KEYS.enter));

  expect(ctx.daemon.collectSent('sources.list')).toStrictEqual([
    { source: 'dirs' },
    { source: 'fake', scope: 'acme', target: 'box' },
  ]);
});

test('it starts a new flow on the default target, not the one the last flow chose', async () => {
  const ctx = setupTest();

  const picker = new SpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    hasDaemonFeature: () => true,
    getLastUsedAgent: () => 'claude',
  });

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ claudeBin: process.execPath, grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  picker.open();

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

  picker.applyKey(Buffer.from(KEYS.enter));
  picker.applyKey(Buffer.from(KEYS.down));
  picker.applyKey(Buffer.from(KEYS.enter));
  picker.applyKey(Buffer.from(KEYS.enter));
  picker.applyKey(Buffer.from(KEYS.enter));

  await ctx.daemon.answer('session.spawn', { session: buildMockSessionDescriptor() });

  picker.open();

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

  picker.applyKey(Buffer.from(KEYS.enter));
  picker.applyKey(Buffer.from(KEYS.enter));
  picker.applyKey(Buffer.from(KEYS.enter));
  picker.applyKey(Buffer.from(KEYS.enter));

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
  const ctx = setupTest();

  const picker = new SpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    hasDaemonFeature: () => true,
    getLastUsedAgent: () => 'claude',
  });

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ claudeBin: process.execPath, grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  picker.open();

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

  picker.applyKey(Buffer.from(KEYS.tab));

  await ctx.daemon.answer('sources.list', { source: 'dirs', scope: null, candidates: [] });

  picker.applyKey(Buffer.from(KEYS.tab));

  expect(ctx.daemon.collectSent('sources.list')).toStrictEqual([
    { source: 'fake', target: 'local' },
    { source: 'dirs' },
    { source: 'fake', target: 'local' },
  ]);
});

test('it reads the targets and sources at once when one agent is installed', () => {
  const ctx = setupTest();

  const picker = new SpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    hasDaemonFeature: () => true,
    getLastUsedAgent: () => 'claude',
  });

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ claudeBin: process.execPath, grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  picker.open();

  expect(ctx.daemon.collectSent('agents.list')).toStrictEqual([{}]);
});

test('it waits on the agent choice when more than one agent is installed', () => {
  const ctx = setupTest();

  const picker = new SpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    hasDaemonFeature: () => true,
    getLastUsedAgent: () => 'claude',
  });

  writeFileSync(
    ctx.configPath,
    JSON.stringify({
      claudeBin: process.execPath,
      grokBin: process.execPath,
      codexBin: 'no-codex',
    }),
  );

  picker.open();

  expect(ctx.daemon.collectSent('agents.list')).toStrictEqual([]);
});

test('it shows how to install an agent when none is installed', () => {
  const ctx = setupTest();

  const picker = new SpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    hasDaemonFeature: () => true,
    getLastUsedAgent: () => 'claude',
  });

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ claudeBin: 'no-claude', grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  picker.open();

  expect(ctx.terminal.getText()).toInclude('no agent CLI found');
  expect(ctx.daemon.collectSent('agents.list')).toStrictEqual([]);
});

test('it reads the targets and sources once when enter repeats on the agent step', () => {
  const ctx = setupTest();

  const picker = new SpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    hasDaemonFeature: () => true,
    getLastUsedAgent: () => 'claude',
  });

  writeFileSync(
    ctx.configPath,
    JSON.stringify({
      claudeBin: process.execPath,
      grokBin: process.execPath,
      codexBin: 'no-codex',
    }),
  );

  picker.open();
  picker.applyKey(Buffer.from(KEYS.enter));
  picker.applyKey(Buffer.from(KEYS.down));
  picker.applyKey(Buffer.from(KEYS.enter));

  expect(ctx.daemon.collectSent('agents.list')).toStrictEqual([{}]);
});

test('it returns esc from the directory step to the agent step when more than one agent is installed', async () => {
  const ctx = setupTest();

  const picker = new SpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    hasDaemonFeature: () => true,
    getLastUsedAgent: () => 'claude',
  });

  writeFileSync(
    ctx.configPath,
    JSON.stringify({
      claudeBin: process.execPath,
      grokBin: process.execPath,
      codexBin: 'no-codex',
    }),
  );

  picker.open();
  picker.applyKey(Buffer.from(KEYS.enter));

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

  const mark = ctx.terminal.mark();

  picker.applyKey(Buffer.from(KEYS.esc));

  expect(ctx.terminal.getTextSince(mark)).toInclude('spawn: agent');
  expect(ctx.counts.exits).toBe(0);
});

test('it leaves the flow on esc from the directory step when one agent is installed', async () => {
  const ctx = setupTest();

  const picker = new SpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    hasDaemonFeature: () => true,
    getLastUsedAgent: () => 'claude',
  });

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ claudeBin: process.execPath, grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  picker.open();

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

  picker.applyKey(Buffer.from(KEYS.esc));

  expect(ctx.counts.exits).toBe(1);
});

test('it opens the name step after the directory when one agent and one target leave no choice', async () => {
  const ctx = setupTest();

  const picker = new SpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    hasDaemonFeature: () => true,
    getLastUsedAgent: () => 'claude',
  });

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ claudeBin: process.execPath, grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  picker.open();

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

  const mark = ctx.terminal.mark();

  picker.applyKey(Buffer.from(KEYS.enter));

  const shown = ctx.terminal.getTextSince(mark);

  expect(shown).toInclude('spawn: name');
  expect(shown).not.toInclude('spawn: target');
});

test('it returns esc from the name step to the directory step when one target left no choice', async () => {
  const ctx = setupTest();

  const picker = new SpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    hasDaemonFeature: () => true,
    getLastUsedAgent: () => 'claude',
  });

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ claudeBin: process.execPath, grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  picker.open();

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

  picker.applyKey(Buffer.from(KEYS.enter));

  const mark = ctx.terminal.mark();

  picker.applyKey(Buffer.from(KEYS.esc));

  expect(ctx.terminal.getTextSince(mark)).toInclude('spawn: directory on the daemon host');
  expect(ctx.counts.exits).toBe(0);
});

test('it lists a git source for the one target without a key when one agent and one target leave no choice', async () => {
  const ctx = setupTest();

  const picker = new SpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    hasDaemonFeature: () => true,
    getLastUsedAgent: () => 'claude',
  });

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ claudeBin: process.execPath, grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  picker.open();

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
  const ctx = setupTest();

  const picker = new SpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    hasDaemonFeature: () => true,
    getLastUsedAgent: () => 'claude',
  });

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ claudeBin: process.execPath, grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  picker.open();

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

  picker.applyKey(Buffer.from(KEYS.esc));

  expect(ctx.counts.exits).toBe(1);
});

test('it takes the one available target for a directory when the other is unavailable', async () => {
  const ctx = setupTest();

  const picker = new SpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    hasDaemonFeature: () => true,
    getLastUsedAgent: () => 'claude',
  });

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ claudeBin: process.execPath, grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  picker.open();

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

  picker.applyKey(Buffer.from(KEYS.enter));
  picker.applyKey(Buffer.from(KEYS.enter));
  picker.applyKey(Buffer.from(KEYS.enter));

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
  const ctx = setupTest();

  const picker = new SpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    hasDaemonFeature: () => true,
    getLastUsedAgent: () => 'claude',
  });

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ claudeBin: process.execPath, grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  picker.open();

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
  const ctx = setupTest();

  const picker = new SpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    hasDaemonFeature: () => true,
    getLastUsedAgent: () => 'claude',
  });

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ claudeBin: process.execPath, grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  picker.open();

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

  const mark = ctx.terminal.mark();

  picker.applyKey(Buffer.from(KEYS.enter));

  expect(ctx.terminal.getTextSince(mark)).toInclude('spawn: target');
});

test('it shows why no target can run a directory when the one target is unavailable', async () => {
  const ctx = setupTest();

  const picker = new SpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    hasDaemonFeature: () => true,
    getLastUsedAgent: () => 'claude',
  });

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ claudeBin: process.execPath, grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  picker.open();

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

  const mark = ctx.terminal.mark();

  picker.applyKey(Buffer.from(KEYS.enter));

  const shown = ctx.terminal.getTextSince(mark);

  expect(shown).toInclude('spawn: target');
  expect(shown).toInclude('none of these targets can run');
});

test('it shows why no target can run a repository when none takes a workspace', async () => {
  const ctx = setupTest();

  const picker = new SpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    hasDaemonFeature: () => true,
    getLastUsedAgent: () => 'claude',
  });

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ claudeBin: process.execPath, grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  picker.open();

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
  const ctx = setupTest();

  const picker = new SpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    hasDaemonFeature: () => true,
    getLastUsedAgent: () => 'claude',
  });

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ claudeBin: process.execPath, grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  picker.open();

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

  const mark = ctx.terminal.mark();

  picker.applyKey(Buffer.from(KEYS.enter));

  expect(ctx.terminal.getTextSince(mark)).toInclude(
    'no target reaches the credential broker claude needs',
  );

  expect(ctx.daemon.collectSent('session.spawn')).toStrictEqual([]);
});

test('it shows why no target can adopt when none runs on the daemon host', async () => {
  const ctx = setupTest();

  const picker = new SpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    hasDaemonFeature: () => true,
    getLastUsedAgent: () => 'claude',
  });

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ claudeBin: process.execPath, grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  picker.open(true);

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

  const mark = ctx.terminal.mark();

  picker.applyKey(Buffer.from(KEYS.enter));

  expect(ctx.terminal.getTextSince(mark)).toInclude('no target on this host can adopt a session');
  expect(ctx.daemon.collectSent('session.spawn')).toStrictEqual([]);
});

test('it returns esc from a target step with no usable target to the directory step', async () => {
  const ctx = setupTest();

  const picker = new SpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    hasDaemonFeature: () => true,
    getLastUsedAgent: () => 'claude',
  });

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ claudeBin: process.execPath, grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  picker.open();

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

  picker.applyKey(Buffer.from(KEYS.enter));

  const mark = ctx.terminal.mark();

  picker.applyKey(Buffer.from(KEYS.esc));

  expect(ctx.terminal.getTextSince(mark)).toInclude('spawn: directory on the daemon host');
  expect(ctx.counts.exits).toBe(0);
});

test('it drops the target and source answer of a flow that was left and opened again', async () => {
  const ctx = setupTest();

  const picker = new SpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    hasDaemonFeature: () => true,
    getLastUsedAgent: () => 'claude',
  });

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ claudeBin: process.execPath, grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  picker.open();
  picker.applyKey(Buffer.from(KEYS.esc));
  picker.open();

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
  const ctx = setupTest();

  const picker = new SpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    hasDaemonFeature: () => true,
    getLastUsedAgent: () => 'claude',
  });

  writeFileSync(
    ctx.configPath,
    JSON.stringify({
      claudeBin: process.execPath,
      grokBin: process.execPath,
      codexBin: 'no-codex',
    }),
  );

  picker.open();
  picker.applyKey(Buffer.from(KEYS.enter));

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

  const mark = ctx.terminal.mark();

  picker.applyKey(Buffer.from(KEYS.esc));

  expect(ctx.terminal.getTextSince(mark)).toInclude('spawn: agent');
  expect(ctx.counts.exits).toBe(0);
});
