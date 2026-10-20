import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { resolveHomeDir } from '@atc/config/host';
import { DaemonError } from '@atc/protocol/wire';
import {
  KEYS,
  buildMockListedAgent,
  buildMockSessionDescriptor,
  buildStubClock,
  buildStubDaemonRequests,
  buildStubTerminal,
} from '@atc/test-utils';
import { buildStubPickerHost } from '../test-utils/build-stub-picker-host';
import { openListingCache } from './open-listing-cache';
import { SpawnPicker } from './spawn-picker';
import { toMirrorSession } from './to-mirror-session';

function setupTest() {
  // the directory filter fuzzy-matches every typed character in order. The temp root sits
  // directly under /tmp, whatever TMPDIR holds, so the only separators in its path come
  // before any letter a filter such as `acme/` needs.
  const cwd = mkdtempSync('/tmp/atc-spawn-picker-');

  onTestFinished(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  const host = buildStubPickerHost();
  const terminal = buildStubTerminal();
  const daemon = buildStubDaemonRequests({ countReactions: host.countReactions });
  const clock = buildStubClock(1_000_000_000);
  const configPath = join(cwd, 'config.json');

  const deps = {
    sendRequest: (method: string, params?: Readonly<Record<string, unknown>>) =>
      daemon.sendRequest(method, params),
    isLeaderKey: (buf: Buffer) => buf.toString() === KEYS.ctrlRightBracket,
    scheduleStatus: host.scheduleStatus,
    showBase: host.showBase,
    attach: host.attach,
    toMirrorSession,
    upsertMirror: () => {},
    write: terminal.write,
    cwd,
    home: resolveHomeDir(),
    configPath,
    onDropAnswer: host.onDropAnswer,
    clock,
  };

  return {
    deps,
    daemon,
    terminal,
    counts: host.counts,
    dropped: host.dropped,
    cwd,
    configPath,
    clock,
  };
}

test('it drops the agent list that arrives after esc leaves the agent step', async () => {
  const ctx = setupTest();

  const picker = new SpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    getLastUsedAgent: () => 'claude',
  });

  picker.open();
  picker.applyKey(Buffer.from(KEYS.esc));

  const renders = ctx.counts.renders;

  await ctx.daemon.answer('agents.list', {
    agents: [
      buildMockListedAgent({ id: 'claude', installed: true, capabilities: { spawn: true } }),
      buildMockListedAgent({ id: 'grok', installed: true, capabilities: { spawn: true } }),
      buildMockListedAgent({ id: 'codex' }),
    ],
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
  expect(ctx.dropped).toStrictEqual(['agent list']);
  expect(ctx.daemon.collectSent('sources.list')).toStrictEqual([]);
});

test('it refuses a spawn on a daemon that offers no sources', async () => {
  const ctx = setupTest();

  const picker = new SpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    getLastUsedAgent: () => 'claude',
  });

  picker.open();

  const mark = ctx.terminal.countChunks();

  await ctx.daemon.answer('agents.list', {
    agents: [
      buildMockListedAgent({ id: 'claude', installed: true, capabilities: { spawn: true } }),
      buildMockListedAgent({ id: 'grok' }),
      buildMockListedAgent({ id: 'codex' }),
    ],
    targets: [
      {
        id: 'local',
        provider: 'local-pty',
        available: true,
        default: true,
        capabilities: { transfer: true, run: true },
      },
    ],
    sources: [],
  });

  const shown = ctx.terminal.getTextSince(mark);

  expect(shown).toInclude('the daemon offers no sources · set workspaces.sources · esc cancel');
  expect(shown).not.toInclude(ctx.cwd);
  expect(ctx.daemon.collectSent('dirs.list')).toStrictEqual([]);
  expect(ctx.daemon.collectSent('sources.list')).toStrictEqual([]);
});

test('it refuses an adopt on a daemon that offers no source of directories', async () => {
  const ctx = setupTest();

  const picker = new SpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    getLastUsedAgent: () => 'claude',
  });

  picker.open(true);

  const mark = ctx.terminal.countChunks();

  await ctx.daemon.answer('agents.list', {
    agents: [
      buildMockListedAgent({ id: 'claude', installed: true, capabilities: { spawn: true } }),
      buildMockListedAgent({ id: 'grok' }),
      buildMockListedAgent({ id: 'codex' }),
    ],
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

  expect(ctx.terminal.getTextSince(mark)).toInclude(
    'no directory source to adopt in · set workspaces.sources · esc cancel',
  );

  expect(ctx.daemon.collectSent('dirs.list')).toStrictEqual([]);
  expect(ctx.daemon.collectSent('sources.list')).toStrictEqual([]);
});

test('it leaves the flow on esc from the refusal of a daemon that offers no sources', async () => {
  const ctx = setupTest();

  const picker = new SpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    getLastUsedAgent: () => 'claude',
  });

  picker.open();

  await ctx.daemon.answer('agents.list', {
    agents: [
      buildMockListedAgent({ id: 'claude', installed: true, capabilities: { spawn: true } }),
      buildMockListedAgent({ id: 'grok' }),
      buildMockListedAgent({ id: 'codex' }),
    ],
    targets: [
      {
        id: 'local',
        provider: 'local-pty',
        available: true,
        default: true,
        capabilities: { transfer: true, run: true },
      },
    ],
    sources: [],
  });

  picker.applyKey(Buffer.from(KEYS.esc));

  expect(ctx.counts.exits).toBe(1);
});

test('it drops a git listing that arrives after the leader leaves the flow', async () => {
  const ctx = setupTest();

  const picker = new SpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    getLastUsedAgent: () => 'claude',
  });

  picker.open();

  await ctx.daemon.answer('agents.list', {
    agents: [
      buildMockListedAgent({ id: 'claude', installed: true, capabilities: { spawn: true } }),
      buildMockListedAgent({ id: 'grok' }),
      buildMockListedAgent({ id: 'codex' }),
    ],
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
    getLastUsedAgent: () => 'claude',
  });

  picker.open();

  await ctx.daemon.answer('agents.list', {
    agents: [
      buildMockListedAgent({ id: 'claude', installed: true, capabilities: { spawn: true } }),
      buildMockListedAgent({ id: 'grok' }),
      buildMockListedAgent({ id: 'codex' }),
    ],
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
    candidates: [{ label: '/srv/one', pick: { kind: 'path', directory: '/srv/one' } }],
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
    getLastUsedAgent: () => 'claude',
  });

  picker.open();

  await ctx.daemon.answer('agents.list', {
    agents: [
      buildMockListedAgent({ id: 'claude', installed: true, capabilities: { spawn: true } }),
      buildMockListedAgent({ id: 'grok' }),
      buildMockListedAgent({ id: 'codex' }),
    ],
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
    getLastUsedAgent: () => 'claude',
  });

  picker.open();

  await ctx.daemon.answer('agents.list', {
    agents: [
      buildMockListedAgent({ id: 'claude', installed: true, capabilities: { spawn: true } }),
      buildMockListedAgent({ id: 'grok' }),
      buildMockListedAgent({ id: 'codex' }),
    ],
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
    getLastUsedAgent: () => 'claude',
  });

  picker.open();

  await ctx.daemon.answer('agents.list', {
    agents: [
      buildMockListedAgent({ id: 'claude', installed: true, capabilities: { spawn: true } }),
      buildMockListedAgent({ id: 'grok' }),
      buildMockListedAgent({ id: 'codex' }),
    ],
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
    getLastUsedAgent: () => 'claude',
  });

  picker.open();

  await ctx.daemon.answer('agents.list', {
    agents: [
      buildMockListedAgent({ id: 'claude', installed: true, capabilities: { spawn: true } }),
      buildMockListedAgent({ id: 'grok' }),
      buildMockListedAgent({ id: 'codex' }),
    ],
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
    getLastUsedAgent: () => 'claude',
  });

  picker.open();

  await ctx.daemon.answer('agents.list', {
    agents: [
      buildMockListedAgent({ id: 'claude', installed: true, capabilities: { spawn: true } }),
      buildMockListedAgent({ id: 'grok' }),
      buildMockListedAgent({ id: 'codex' }),
    ],
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

  const mark = ctx.terminal.countChunks();

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
    getLastUsedAgent: () => 'claude',
  });

  picker.open();

  await ctx.daemon.answer('agents.list', {
    agents: [
      buildMockListedAgent({ id: 'claude', installed: true, capabilities: { spawn: true } }),
      buildMockListedAgent({ id: 'grok' }),
      buildMockListedAgent({ id: 'codex' }),
    ],
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
    getLastUsedAgent: () => 'claude',
  });

  picker.open();

  await ctx.daemon.answer('agents.list', {
    agents: [
      buildMockListedAgent({ id: 'claude', installed: true, capabilities: { spawn: true } }),
      buildMockListedAgent({ id: 'grok' }),
      buildMockListedAgent({ id: 'codex' }),
    ],
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
    agents: [
      buildMockListedAgent({ id: 'claude', installed: true, capabilities: { spawn: true } }),
      buildMockListedAgent({ id: 'grok' }),
      buildMockListedAgent({ id: 'codex' }),
    ],
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

test('it holds a session whose workspace left changes behind instead of attaching it', async () => {
  const ctx = setupTest();

  const picker = new SpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    getLastUsedAgent: () => 'claude',
  });

  picker.open();

  await ctx.daemon.answer('agents.list', {
    agents: [
      buildMockListedAgent({ id: 'claude', installed: true, capabilities: { spawn: true } }),
      buildMockListedAgent({ id: 'grok' }),
      buildMockListedAgent({ id: 'codex' }),
    ],
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
    getLastUsedAgent: () => 'claude',
  });

  picker.open();

  await ctx.daemon.answer('agents.list', {
    agents: [
      buildMockListedAgent({ id: 'claude', installed: true, capabilities: { spawn: true } }),
      buildMockListedAgent({ id: 'grok' }),
      buildMockListedAgent({ id: 'codex' }),
    ],
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
    getLastUsedAgent: () => 'claude',
  });

  picker.open();

  await ctx.daemon.answer('agents.list', {
    agents: [
      buildMockListedAgent({ id: 'claude', installed: true, capabilities: { spawn: true } }),
      buildMockListedAgent({ id: 'grok' }),
      buildMockListedAgent({ id: 'codex' }),
    ],
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

  const mark = ctx.terminal.countChunks();

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
    getLastUsedAgent: () => 'claude',
  });

  picker.open();

  await ctx.daemon.answer('agents.list', {
    agents: [
      buildMockListedAgent({ id: 'claude', installed: true, capabilities: { spawn: true } }),
      buildMockListedAgent({ id: 'grok' }),
      buildMockListedAgent({ id: 'codex' }),
    ],
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
    getLastUsedAgent: () => 'claude',
  });

  picker.open();

  await ctx.daemon.answer('agents.list', {
    agents: [
      buildMockListedAgent({ id: 'claude', installed: true, capabilities: { spawn: true } }),
      buildMockListedAgent({ id: 'grok' }),
      buildMockListedAgent({ id: 'codex' }),
    ],
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
    getLastUsedAgent: () => 'claude',
  });

  picker.open();

  await ctx.daemon.answer('agents.list', {
    agents: [
      buildMockListedAgent({ id: 'claude', installed: true, capabilities: { spawn: true } }),
      buildMockListedAgent({ id: 'grok' }),
      buildMockListedAgent({ id: 'codex' }),
    ],
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
    getLastUsedAgent: () => 'claude',
  });

  picker.open(true);

  await ctx.daemon.answer('agents.list', {
    agents: [
      buildMockListedAgent({ id: 'claude', installed: true, capabilities: { spawn: true } }),
      buildMockListedAgent({ id: 'grok' }),
      buildMockListedAgent({ id: 'codex' }),
    ],
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
    getLastUsedAgent: () => 'claude',
  });

  picker.open();

  await ctx.daemon.answer('agents.list', {
    agents: [
      buildMockListedAgent({
        id: 'claude',
        installed: true,
        brokerAuth: true,
        brokerRequired: true,
        capabilities: { spawn: true },
      }),
    ],
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
    getLastUsedAgent: () => 'claude',
  });

  picker.open();

  await ctx.daemon.answer('agents.list', {
    agents: [
      buildMockListedAgent({
        id: 'claude',
        installed: true,
        brokerAuth: false,
        brokerRequired: false,
        capabilities: { spawn: true },
      }),
    ],
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
    getLastUsedAgent: () => 'claude',
  });

  picker.open();

  await ctx.daemon.answer('agents.list', {
    agents: [
      buildMockListedAgent({
        id: 'claude',
        installed: true,
        brokerAuth: true,
        brokerRequired: false,
        capabilities: { spawn: true },
      }),
    ],
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

test('it offers every target to an agent that takes the broker credential without brokerRequired', async () => {
  const ctx = setupTest();

  const picker = new SpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    getLastUsedAgent: () => 'claude',
  });

  picker.open();

  await ctx.daemon.answer('agents.list', {
    agents: [
      buildMockListedAgent({
        id: 'claude',
        installed: true,
        brokerAuth: true,
        capabilities: { spawn: true },
      }),
    ],
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
    getLastUsedAgent: () => 'claude',
  });

  picker.open();

  await ctx.daemon.answer('agents.list', {
    agents: [
      buildMockListedAgent({ id: 'claude', installed: true, capabilities: { spawn: true } }),
      buildMockListedAgent({ id: 'grok' }),
      buildMockListedAgent({ id: 'codex' }),
    ],
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
    getLastUsedAgent: () => 'claude',
  });

  picker.open();

  await ctx.daemon.answer('agents.list', {
    agents: [
      buildMockListedAgent({ id: 'claude', installed: true, capabilities: { spawn: true } }),
      buildMockListedAgent({ id: 'grok' }),
      buildMockListedAgent({ id: 'codex' }),
    ],
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
    agents: [
      buildMockListedAgent({ id: 'claude', installed: true, capabilities: { spawn: true } }),
      buildMockListedAgent({ id: 'grok' }),
      buildMockListedAgent({ id: 'codex' }),
    ],
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
    getLastUsedAgent: () => 'claude',
  });

  picker.open();

  await ctx.daemon.answer('agents.list', {
    agents: [
      buildMockListedAgent({ id: 'claude', installed: true, capabilities: { spawn: true } }),
      buildMockListedAgent({ id: 'grok' }),
      buildMockListedAgent({ id: 'codex' }),
    ],
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

test('it asks the daemon for its agents as it opens', () => {
  const ctx = setupTest();

  const picker = new SpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    getLastUsedAgent: () => 'claude',
  });

  picker.open();

  expect(ctx.daemon.collectSent('agents.list')).toStrictEqual([{}]);
});

test('it leaves an agent the daemon lists as not installed or unable to spawn out of the menu', async () => {
  const ctx = setupTest();

  const picker = new SpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    getLastUsedAgent: () => 'claude',
  });

  picker.open();

  const mark = ctx.terminal.countChunks();

  await ctx.daemon.answer('agents.list', {
    agents: [
      buildMockListedAgent({
        id: 'claude',
        label: 'Ready Claude',
        installed: true,
        capabilities: { spawn: true },
      }),
      buildMockListedAgent({
        id: 'grok',
        label: 'Missing Grok',
        installed: false,
        capabilities: { spawn: true },
      }),
      buildMockListedAgent({
        id: 'codex',
        label: 'Refused Codex',
        installed: true,
        capabilities: { spawn: false },
      }),
      buildMockListedAgent({
        id: 'proxy',
        label: 'Ready Proxy',
        installed: true,
        capabilities: { spawn: true },
      }),
    ],
    targets: [],
    sources: [{ id: 'dirs', label: 'directory on the daemon host', kind: 'path' }],
  });

  const shown = ctx.terminal.getTextSince(mark);

  expect(shown).toInclude('Ready Claude');
  expect(shown).toInclude('Ready Proxy');
  expect(shown).not.toInclude('Missing Grok');
  expect(shown).not.toInclude('Refused Codex');
});

test('it opens the first source without a menu when the daemon can start one agent', async () => {
  const ctx = setupTest();

  const picker = new SpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    getLastUsedAgent: () => 'claude',
  });

  picker.open();

  await ctx.daemon.answer('agents.list', {
    agents: [
      buildMockListedAgent({ id: 'claude', installed: true, capabilities: { spawn: true } }),
      buildMockListedAgent({ id: 'grok', installed: false, capabilities: { spawn: true } }),
    ],
    targets: [],
    sources: [{ id: 'dirs', label: 'directory on the daemon host', kind: 'path' }],
  });

  expect(ctx.daemon.collectSent('sources.list')).toStrictEqual([{ source: 'dirs' }]);
});

test('it shows how to install an agent when the daemon can start none', async () => {
  const ctx = setupTest();

  const picker = new SpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    getLastUsedAgent: () => 'claude',
  });

  picker.open();

  const mark = ctx.terminal.countChunks();

  await ctx.daemon.answer('agents.list', {
    agents: [buildMockListedAgent({ id: 'claude', installed: false })],
    targets: [],
    sources: [{ id: 'dirs', label: 'directory on the daemon host', kind: 'path' }],
  });

  expect(ctx.terminal.getTextSince(mark)).toInclude('the daemon can start no agent');
  expect(ctx.daemon.collectSent('sources.list')).toStrictEqual([]);
});

test("it shows why the daemon's agent list failed in place of the menu", async () => {
  const ctx = setupTest();

  const picker = new SpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    getLastUsedAgent: () => 'claude',
  });

  picker.open();

  const mark = ctx.terminal.countChunks();

  await ctx.daemon.refuse('agents.list', new DaemonError('internal', 'the config is unreadable'));

  expect(ctx.terminal.getTextSince(mark)).toInclude(
    'cannot read the agents: internal: the config is unreadable · esc cancel',
  );
});

test('it lists the first source once when enter repeats on the agent step', async () => {
  const ctx = setupTest();

  const picker = new SpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    getLastUsedAgent: () => 'claude',
  });

  picker.open();

  await ctx.daemon.answer('agents.list', {
    agents: [
      buildMockListedAgent({ id: 'claude', installed: true, capabilities: { spawn: true } }),
      buildMockListedAgent({ id: 'grok', installed: true, capabilities: { spawn: true } }),
    ],
    targets: [],
    sources: [{ id: 'dirs', label: 'directory on the daemon host', kind: 'path' }],
  });

  picker.applyKey(Buffer.from(KEYS.enter));
  picker.applyKey(Buffer.from(KEYS.down));
  picker.applyKey(Buffer.from(KEYS.enter));

  expect(ctx.daemon.collectSent('sources.list')).toStrictEqual([{ source: 'dirs' }]);
});

test('it returns esc from the directory step to the agent step when more than one agent is installed', async () => {
  const ctx = setupTest();

  const picker = new SpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    getLastUsedAgent: () => 'claude',
  });

  picker.open();

  await ctx.daemon.answer('agents.list', {
    agents: [
      buildMockListedAgent({ id: 'claude', installed: true, capabilities: { spawn: true } }),
      buildMockListedAgent({ id: 'grok', installed: true, capabilities: { spawn: true } }),
      buildMockListedAgent({ id: 'codex' }),
    ],
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

  picker.applyKey(Buffer.from(KEYS.enter));

  await ctx.daemon.answer('sources.list', { source: 'dirs', scope: null, candidates: [] });

  const mark = ctx.terminal.countChunks();

  picker.applyKey(Buffer.from(KEYS.esc));

  expect(ctx.terminal.getTextSince(mark)).toInclude('spawn: agent');
  expect(ctx.counts.exits).toBe(0);
});

test('it leaves the flow on esc from the directory step when one agent is installed', async () => {
  const ctx = setupTest();

  const picker = new SpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    getLastUsedAgent: () => 'claude',
  });

  picker.open();

  await ctx.daemon.answer('agents.list', {
    agents: [
      buildMockListedAgent({ id: 'claude', installed: true, capabilities: { spawn: true } }),
      buildMockListedAgent({ id: 'grok' }),
      buildMockListedAgent({ id: 'codex' }),
    ],
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
    getLastUsedAgent: () => 'claude',
  });

  picker.open();

  await ctx.daemon.answer('agents.list', {
    agents: [
      buildMockListedAgent({ id: 'claude', installed: true, capabilities: { spawn: true } }),
      buildMockListedAgent({ id: 'grok' }),
      buildMockListedAgent({ id: 'codex' }),
    ],
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

  const mark = ctx.terminal.countChunks();

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
    getLastUsedAgent: () => 'claude',
  });

  picker.open();

  await ctx.daemon.answer('agents.list', {
    agents: [
      buildMockListedAgent({ id: 'claude', installed: true, capabilities: { spawn: true } }),
      buildMockListedAgent({ id: 'grok' }),
      buildMockListedAgent({ id: 'codex' }),
    ],
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

  const mark = ctx.terminal.countChunks();

  picker.applyKey(Buffer.from(KEYS.esc));

  expect(ctx.terminal.getTextSince(mark)).toInclude('spawn: directory on the daemon host');
  expect(ctx.counts.exits).toBe(0);
});

test('it lists a git source for the one target without a key when one agent and one target leave no choice', async () => {
  const ctx = setupTest();

  const picker = new SpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    getLastUsedAgent: () => 'claude',
  });

  picker.open();

  await ctx.daemon.answer('agents.list', {
    agents: [
      buildMockListedAgent({ id: 'claude', installed: true, capabilities: { spawn: true } }),
      buildMockListedAgent({ id: 'grok' }),
      buildMockListedAgent({ id: 'codex' }),
    ],
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
    getLastUsedAgent: () => 'claude',
  });

  picker.open();

  await ctx.daemon.answer('agents.list', {
    agents: [
      buildMockListedAgent({ id: 'claude', installed: true, capabilities: { spawn: true } }),
      buildMockListedAgent({ id: 'grok' }),
      buildMockListedAgent({ id: 'codex' }),
    ],
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
    getLastUsedAgent: () => 'claude',
  });

  picker.open();

  await ctx.daemon.answer('agents.list', {
    agents: [
      buildMockListedAgent({ id: 'claude', installed: true, capabilities: { spawn: true } }),
      buildMockListedAgent({ id: 'grok' }),
      buildMockListedAgent({ id: 'codex' }),
    ],
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
    getLastUsedAgent: () => 'claude',
  });

  picker.open();

  await ctx.daemon.answer('agents.list', {
    agents: [
      buildMockListedAgent({ id: 'claude', installed: true, capabilities: { spawn: true } }),
      buildMockListedAgent({ id: 'grok' }),
      buildMockListedAgent({ id: 'codex' }),
    ],
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
    getLastUsedAgent: () => 'claude',
  });

  picker.open();

  await ctx.daemon.answer('agents.list', {
    agents: [
      buildMockListedAgent({ id: 'claude', installed: true, capabilities: { spawn: true } }),
      buildMockListedAgent({ id: 'grok' }),
      buildMockListedAgent({ id: 'codex' }),
    ],
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

  const mark = ctx.terminal.countChunks();

  picker.applyKey(Buffer.from(KEYS.enter));

  expect(ctx.terminal.getTextSince(mark)).toInclude('spawn: target');
});

test('it shows why no target can run a directory when the one target is unavailable', async () => {
  const ctx = setupTest();

  const picker = new SpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    getLastUsedAgent: () => 'claude',
  });

  picker.open();

  await ctx.daemon.answer('agents.list', {
    agents: [
      buildMockListedAgent({ id: 'claude', installed: true, capabilities: { spawn: true } }),
      buildMockListedAgent({ id: 'grok' }),
      buildMockListedAgent({ id: 'codex' }),
    ],
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

  const mark = ctx.terminal.countChunks();

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
    getLastUsedAgent: () => 'claude',
  });

  picker.open();

  await ctx.daemon.answer('agents.list', {
    agents: [
      buildMockListedAgent({ id: 'claude', installed: true, capabilities: { spawn: true } }),
      buildMockListedAgent({ id: 'grok' }),
      buildMockListedAgent({ id: 'codex' }),
    ],
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
    getLastUsedAgent: () => 'claude',
  });

  picker.open();

  await ctx.daemon.answer('agents.list', {
    agents: [
      buildMockListedAgent({
        id: 'claude',
        installed: true,
        brokerAuth: true,
        brokerRequired: true,
        capabilities: { spawn: true },
      }),
    ],
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

  const mark = ctx.terminal.countChunks();

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
    getLastUsedAgent: () => 'claude',
  });

  picker.open(true);

  await ctx.daemon.answer('agents.list', {
    agents: [
      buildMockListedAgent({ id: 'claude', installed: true, capabilities: { spawn: true } }),
      buildMockListedAgent({ id: 'grok' }),
      buildMockListedAgent({ id: 'codex' }),
    ],
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

  const mark = ctx.terminal.countChunks();

  picker.applyKey(Buffer.from(KEYS.enter));

  expect(ctx.terminal.getTextSince(mark)).toInclude('no target on this host can adopt a session');
  expect(ctx.daemon.collectSent('session.spawn')).toStrictEqual([]);
});

test('it returns esc from a target step with no usable target to the directory step', async () => {
  const ctx = setupTest();

  const picker = new SpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    getLastUsedAgent: () => 'claude',
  });

  picker.open();

  await ctx.daemon.answer('agents.list', {
    agents: [
      buildMockListedAgent({ id: 'claude', installed: true, capabilities: { spawn: true } }),
      buildMockListedAgent({ id: 'grok' }),
      buildMockListedAgent({ id: 'codex' }),
    ],
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

  const mark = ctx.terminal.countChunks();

  picker.applyKey(Buffer.from(KEYS.esc));

  expect(ctx.terminal.getTextSince(mark)).toInclude('spawn: directory on the daemon host');
  expect(ctx.counts.exits).toBe(0);
});

test('it drops the agent list of a flow that was left and opened again', async () => {
  const ctx = setupTest();

  const picker = new SpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    getLastUsedAgent: () => 'claude',
  });

  picker.open();
  picker.applyKey(Buffer.from(KEYS.esc));
  picker.open();

  const renders = ctx.counts.renders;

  await ctx.daemon.answerOldest('agents.list', {
    agents: [
      buildMockListedAgent({ id: 'claude', installed: true, capabilities: { spawn: true } }),
    ],
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
  expect(ctx.dropped).toStrictEqual(['agent list']);
});

test('it returns esc from a git source to the agent step when one target left no choice', async () => {
  const ctx = setupTest();

  const picker = new SpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    getLastUsedAgent: () => 'claude',
  });

  picker.open();

  await ctx.daemon.answer('agents.list', {
    agents: [
      buildMockListedAgent({ id: 'claude', installed: true, capabilities: { spawn: true } }),
      buildMockListedAgent({ id: 'grok', installed: true, capabilities: { spawn: true } }),
      buildMockListedAgent({ id: 'codex' }),
    ],
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

  picker.applyKey(Buffer.from(KEYS.enter));

  await ctx.daemon.answer('sources.list', { source: 'fake', scope: null, candidates: [] });

  const mark = ctx.terminal.countChunks();

  picker.applyKey(Buffer.from(KEYS.esc));

  expect(ctx.terminal.getTextSince(mark)).toInclude('spawn: agent');
  expect(ctx.counts.exits).toBe(0);
});

test('it shows the listing an earlier client kept at once, marked with its age, while it lists again', async () => {
  const ctx = setupTest();
  const cacheFile = join(ctx.cwd, 'listing-cache.json');

  const earlier = new SpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    getLastUsedAgent: () => 'claude',
    listingCache: openListingCache(cacheFile),
    getDaemonSocketPath: () => '/run/atc/atc.sock',
  });

  earlier.open();

  await ctx.daemon.answer('agents.list', {
    agents: [
      buildMockListedAgent({ id: 'claude', installed: true, capabilities: { spawn: true } }),
      buildMockListedAgent({ id: 'grok' }),
      buildMockListedAgent({ id: 'codex' }),
    ],
    targets: [
      {
        id: 'local',
        provider: 'local-pty',
        available: true,
        default: true,
        capabilities: { transfer: true, run: true },
      },
    ],
    sources: [{ id: 'github', label: 'GitHub repository', kind: 'git' }],
  });

  await ctx.daemon.answer('sources.list', {
    candidates: [{ label: 'acme/app', pick: { kind: 'git', url: 'git@github.com:acme/app.git' } }],
    scope: 'acme',
  });

  earlier.applyKey(Buffer.from(KEYS.ctrlRightBracket));
  ctx.clock.advance(5 * 60_000);

  const picker = new SpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    getLastUsedAgent: () => 'claude',
    listingCache: openListingCache(cacheFile),
    getDaemonSocketPath: () => '/run/atc/atc.sock',
  });

  picker.open();

  const mark = ctx.terminal.countChunks();

  await ctx.daemon.answer('agents.list', {
    agents: [
      buildMockListedAgent({ id: 'claude', installed: true, capabilities: { spawn: true } }),
      buildMockListedAgent({ id: 'grok' }),
      buildMockListedAgent({ id: 'codex' }),
    ],
    targets: [
      {
        id: 'local',
        provider: 'local-pty',
        available: true,
        default: true,
        capabilities: { transfer: true, run: true },
      },
    ],
    sources: [{ id: 'github', label: 'GitHub repository', kind: 'git' }],
  });

  const shown = ctx.terminal.getTextSince(mark);

  expect(shown).toInclude('spawn: GitHub repository · acme · 5m old, refreshing…');
  expect(shown).toInclude('acme/app');

  expect(ctx.daemon.collectSent('sources.list')).toStrictEqual([
    { source: 'github', target: 'local' },
    { source: 'github', target: 'local' },
  ]);
});

test('it swaps the fresh listing in for the cached one when it answers, keeping the selected repository', async () => {
  const ctx = setupTest();

  const picker = new SpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    getLastUsedAgent: () => 'claude',
    listingCache: openListingCache(join(ctx.cwd, 'listing-cache.json')),
    getDaemonSocketPath: () => '/run/atc/atc.sock',
  });

  picker.open();

  await ctx.daemon.answer('agents.list', {
    agents: [
      buildMockListedAgent({ id: 'claude', installed: true, capabilities: { spawn: true } }),
      buildMockListedAgent({ id: 'grok' }),
      buildMockListedAgent({ id: 'codex' }),
    ],
    targets: [
      {
        id: 'local',
        provider: 'local-pty',
        available: true,
        default: true,
        capabilities: { transfer: true, run: true },
      },
    ],
    sources: [{ id: 'github', label: 'GitHub repository', kind: 'git' }],
  });

  await ctx.daemon.answer('sources.list', {
    candidates: [
      { label: 'acme/app', pick: { kind: 'git', url: 'git@github.com:acme/app.git' } },
      { label: 'acme/docs', pick: { kind: 'git', url: 'git@github.com:acme/docs.git' } },
    ],
    scope: 'acme',
  });

  picker.applyKey(Buffer.from(KEYS.ctrlRightBracket));
  ctx.clock.advance(60 * 60_000);
  picker.open();

  await ctx.daemon.answer('agents.list', {
    agents: [
      buildMockListedAgent({ id: 'claude', installed: true, capabilities: { spawn: true } }),
      buildMockListedAgent({ id: 'grok' }),
      buildMockListedAgent({ id: 'codex' }),
    ],
    targets: [
      {
        id: 'local',
        provider: 'local-pty',
        available: true,
        default: true,
        capabilities: { transfer: true, run: true },
      },
    ],
    sources: [{ id: 'github', label: 'GitHub repository', kind: 'git' }],
  });

  picker.applyKey(Buffer.from(KEYS.down));

  const mark = ctx.terminal.countChunks();

  await ctx.daemon.answer('sources.list', {
    candidates: [
      { label: 'acme/new-tool', pick: { kind: 'git', url: 'git@github.com:acme/new-tool.git' } },
      { label: 'acme/app', pick: { kind: 'git', url: 'git@github.com:acme/app.git' } },
      { label: 'acme/docs', pick: { kind: 'git', url: 'git@github.com:acme/docs.git' } },
    ],
    scope: 'acme',
  });

  picker.applyKey(Buffer.from(KEYS.enter));

  const shown = ctx.terminal.getTextSince(mark);

  expect(shown).toInclude('acme/new-tool');
  expect(shown).not.toInclude('old, refreshing…');

  expect(ctx.daemon.collectSent('git.probe')).toStrictEqual([
    { url: 'git@github.com:acme/docs.git', target: 'local' },
  ]);
});

test('it lists again on ctrl-r and shows a repository created since the last listing', async () => {
  const ctx = setupTest();

  const picker = new SpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    getLastUsedAgent: () => 'claude',
    listingCache: openListingCache(join(ctx.cwd, 'listing-cache.json')),
    getDaemonSocketPath: () => '/run/atc/atc.sock',
  });

  picker.open();

  await ctx.daemon.answer('agents.list', {
    agents: [
      buildMockListedAgent({ id: 'claude', installed: true, capabilities: { spawn: true } }),
      buildMockListedAgent({ id: 'grok' }),
      buildMockListedAgent({ id: 'codex' }),
    ],
    targets: [
      {
        id: 'local',
        provider: 'local-pty',
        available: true,
        default: true,
        capabilities: { transfer: true, run: true },
      },
    ],
    sources: [{ id: 'github', label: 'GitHub repository', kind: 'git' }],
  });

  await ctx.daemon.answer('sources.list', {
    candidates: [{ label: 'acme/app', pick: { kind: 'git', url: 'git@github.com:acme/app.git' } }],
    scope: 'acme',
  });

  picker.applyKey(Buffer.from(KEYS.ctrlR));

  const mark = ctx.terminal.countChunks();

  await ctx.daemon.answer('sources.list', {
    candidates: [
      { label: 'acme/app', pick: { kind: 'git', url: 'git@github.com:acme/app.git' } },
      { label: 'acme/new-tool', pick: { kind: 'git', url: 'git@github.com:acme/new-tool.git' } },
    ],
    scope: 'acme',
  });

  expect(ctx.terminal.getTextSince(mark)).toInclude('acme/new-tool');

  expect(ctx.daemon.collectSent('sources.list')).toStrictEqual([
    { source: 'github', target: 'local' },
    { source: 'github', target: 'local' },
  ]);
});

test('it waits on the listing when the kept one is older than a day', async () => {
  const ctx = setupTest();

  const picker = new SpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    getLastUsedAgent: () => 'claude',
    listingCache: openListingCache(join(ctx.cwd, 'listing-cache.json')),
    getDaemonSocketPath: () => '/run/atc/atc.sock',
  });

  picker.open();

  await ctx.daemon.answer('agents.list', {
    agents: [
      buildMockListedAgent({ id: 'claude', installed: true, capabilities: { spawn: true } }),
      buildMockListedAgent({ id: 'grok' }),
      buildMockListedAgent({ id: 'codex' }),
    ],
    targets: [
      {
        id: 'local',
        provider: 'local-pty',
        available: true,
        default: true,
        capabilities: { transfer: true, run: true },
      },
    ],
    sources: [{ id: 'github', label: 'GitHub repository', kind: 'git' }],
  });

  await ctx.daemon.answer('sources.list', {
    candidates: [{ label: 'acme/app', pick: { kind: 'git', url: 'git@github.com:acme/app.git' } }],
    scope: 'acme',
  });

  picker.applyKey(Buffer.from(KEYS.ctrlRightBracket));
  ctx.clock.advance(24 * 60 * 60_000 + 1);
  picker.open();

  const mark = ctx.terminal.countChunks();

  await ctx.daemon.answer('agents.list', {
    agents: [
      buildMockListedAgent({ id: 'claude', installed: true, capabilities: { spawn: true } }),
      buildMockListedAgent({ id: 'grok' }),
      buildMockListedAgent({ id: 'codex' }),
    ],
    targets: [
      {
        id: 'local',
        provider: 'local-pty',
        available: true,
        default: true,
        capabilities: { transfer: true, run: true },
      },
    ],
    sources: [{ id: 'github', label: 'GitHub repository', kind: 'git' }],
  });

  const shown = ctx.terminal.getTextSince(mark);

  expect(shown).toInclude('listing… · esc stops');
  expect(shown).not.toInclude('acme/app');
});

test('it keeps the cached listing with the failure in its hint when listing again fails', async () => {
  const ctx = setupTest();

  const picker = new SpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    getLastUsedAgent: () => 'claude',
    listingCache: openListingCache(join(ctx.cwd, 'listing-cache.json')),
    getDaemonSocketPath: () => '/run/atc/atc.sock',
  });

  picker.open();

  await ctx.daemon.answer('agents.list', {
    agents: [
      buildMockListedAgent({ id: 'claude', installed: true, capabilities: { spawn: true } }),
      buildMockListedAgent({ id: 'grok' }),
      buildMockListedAgent({ id: 'codex' }),
    ],
    targets: [
      {
        id: 'local',
        provider: 'local-pty',
        available: true,
        default: true,
        capabilities: { transfer: true, run: true },
      },
    ],
    sources: [{ id: 'github', label: 'GitHub repository', kind: 'git' }],
  });

  await ctx.daemon.answer('sources.list', {
    candidates: [{ label: 'acme/app', pick: { kind: 'git', url: 'git@github.com:acme/app.git' } }],
    scope: 'acme',
  });

  picker.applyKey(Buffer.from(KEYS.ctrlRightBracket));
  picker.open();

  await ctx.daemon.answer('agents.list', {
    agents: [
      buildMockListedAgent({ id: 'claude', installed: true, capabilities: { spawn: true } }),
      buildMockListedAgent({ id: 'grok' }),
      buildMockListedAgent({ id: 'codex' }),
    ],
    targets: [
      {
        id: 'local',
        provider: 'local-pty',
        available: true,
        default: true,
        capabilities: { transfer: true, run: true },
      },
    ],
    sources: [{ id: 'github', label: 'GitHub repository', kind: 'git' }],
  });

  const mark = ctx.terminal.countChunks();

  await ctx.daemon.refuse(
    'sources.list',
    new DaemonError('github_unavailable', 'gh is not signed in on the daemon host'),
  );

  const shown = ctx.terminal.getTextSince(mark);

  expect(shown).toInclude('refresh failed: gh is not signed in on the daemon host');
  expect(shown).toInclude('acme/app');
});

test('it leaves the source step on esc while it refreshes a cached listing', async () => {
  const ctx = setupTest();

  const picker = new SpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    getLastUsedAgent: () => 'claude',
    listingCache: openListingCache(join(ctx.cwd, 'listing-cache.json')),
    getDaemonSocketPath: () => '/run/atc/atc.sock',
  });

  picker.open();

  await ctx.daemon.answer('agents.list', {
    agents: [
      buildMockListedAgent({ id: 'claude', installed: true, capabilities: { spawn: true } }),
      buildMockListedAgent({ id: 'grok' }),
      buildMockListedAgent({ id: 'codex' }),
    ],
    targets: [
      {
        id: 'local',
        provider: 'local-pty',
        available: true,
        default: true,
        capabilities: { transfer: true, run: true },
      },
    ],
    sources: [{ id: 'github', label: 'GitHub repository', kind: 'git' }],
  });

  await ctx.daemon.answer('sources.list', {
    candidates: [{ label: 'acme/app', pick: { kind: 'git', url: 'git@github.com:acme/app.git' } }],
    scope: 'acme',
  });

  picker.applyKey(Buffer.from(KEYS.ctrlRightBracket));
  picker.open();

  await ctx.daemon.answer('agents.list', {
    agents: [
      buildMockListedAgent({ id: 'claude', installed: true, capabilities: { spawn: true } }),
      buildMockListedAgent({ id: 'grok' }),
      buildMockListedAgent({ id: 'codex' }),
    ],
    targets: [
      {
        id: 'local',
        provider: 'local-pty',
        available: true,
        default: true,
        capabilities: { transfer: true, run: true },
      },
    ],
    sources: [{ id: 'github', label: 'GitHub repository', kind: 'git' }],
  });

  const mark = ctx.terminal.countChunks();

  picker.applyKey(Buffer.from(KEYS.esc));

  expect(ctx.terminal.getTextSince(mark)).not.toInclude('listing stopped');
  expect(ctx.counts.exits).toBe(2);
});

test('it shows nothing from the cache on the next open once a listing answers empty', async () => {
  const ctx = setupTest();

  const picker = new SpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    getLastUsedAgent: () => 'claude',
    listingCache: openListingCache(join(ctx.cwd, 'listing-cache.json')),
    getDaemonSocketPath: () => '/run/atc/atc.sock',
  });

  picker.open();

  await ctx.daemon.answer('agents.list', {
    agents: [
      buildMockListedAgent({ id: 'claude', installed: true, capabilities: { spawn: true } }),
      buildMockListedAgent({ id: 'grok' }),
      buildMockListedAgent({ id: 'codex' }),
    ],
    targets: [
      {
        id: 'local',
        provider: 'local-pty',
        available: true,
        default: true,
        capabilities: { transfer: true, run: true },
      },
    ],
    sources: [{ id: 'github', label: 'GitHub repository', kind: 'git' }],
  });

  await ctx.daemon.answer('sources.list', {
    candidates: [{ label: 'acme/app', pick: { kind: 'git', url: 'git@github.com:acme/app.git' } }],
    scope: 'acme',
  });

  picker.applyKey(Buffer.from(KEYS.ctrlR));

  await ctx.daemon.answer('sources.list', { candidates: [], scope: 'acme' });

  picker.applyKey(Buffer.from(KEYS.ctrlRightBracket));
  picker.open();

  const mark = ctx.terminal.countChunks();

  await ctx.daemon.answer('agents.list', {
    agents: [
      buildMockListedAgent({ id: 'claude', installed: true, capabilities: { spawn: true } }),
      buildMockListedAgent({ id: 'grok' }),
      buildMockListedAgent({ id: 'codex' }),
    ],
    targets: [
      {
        id: 'local',
        provider: 'local-pty',
        available: true,
        default: true,
        capabilities: { transfer: true, run: true },
      },
    ],
    sources: [{ id: 'github', label: 'GitHub repository', kind: 'git' }],
  });

  const shown = ctx.terminal.getTextSince(mark);

  expect(shown).toInclude('nothing listed for acme');
  expect(shown).not.toInclude('acme/app');
});

test('it shows the listing asked for last on the next open when an earlier one answers after it', async () => {
  const ctx = setupTest();

  const picker = new SpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    getLastUsedAgent: () => 'claude',
    listingCache: openListingCache(join(ctx.cwd, 'listing-cache.json')),
    getDaemonSocketPath: () => '/run/atc/atc.sock',
  });

  picker.open();

  await ctx.daemon.answer('agents.list', {
    agents: [
      buildMockListedAgent({ id: 'claude', installed: true, capabilities: { spawn: true } }),
      buildMockListedAgent({ id: 'grok' }),
      buildMockListedAgent({ id: 'codex' }),
    ],
    targets: [
      {
        id: 'local',
        provider: 'local-pty',
        available: true,
        default: true,
        capabilities: { transfer: true, run: true },
      },
    ],
    sources: [{ id: 'github', label: 'GitHub repository', kind: 'git' }],
  });

  ctx.clock.advance(1000);
  picker.applyKey(Buffer.from(KEYS.ctrlR));

  await ctx.daemon.answer('sources.list', {
    candidates: [
      { label: 'acme/new-tool', pick: { kind: 'git', url: 'git@github.com:acme/new-tool.git' } },
    ],
    scope: 'acme',
  });

  await ctx.daemon.answerOldest('sources.list', {
    candidates: [{ label: 'acme/app', pick: { kind: 'git', url: 'git@github.com:acme/app.git' } }],
    scope: 'acme',
  });

  picker.applyKey(Buffer.from(KEYS.ctrlRightBracket));
  picker.open();

  const mark = ctx.terminal.countChunks();

  await ctx.daemon.answer('agents.list', {
    agents: [
      buildMockListedAgent({ id: 'claude', installed: true, capabilities: { spawn: true } }),
      buildMockListedAgent({ id: 'grok' }),
      buildMockListedAgent({ id: 'codex' }),
    ],
    targets: [
      {
        id: 'local',
        provider: 'local-pty',
        available: true,
        default: true,
        capabilities: { transfer: true, run: true },
      },
    ],
    sources: [{ id: 'github', label: 'GitHub repository', kind: 'git' }],
  });

  const shown = ctx.terminal.getTextSince(mark);

  expect(shown).toInclude('acme/new-tool');
  expect(shown).not.toInclude('acme/app');
});

test('it shows the cached listing of an owner typed on the source step at once, while it lists that owner again', async () => {
  const ctx = setupTest();

  const picker = new SpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    getLastUsedAgent: () => 'claude',
    listingCache: openListingCache(join(ctx.cwd, 'listing-cache.json')),
    getDaemonSocketPath: () => '/run/atc/atc.sock',
  });

  picker.open();

  await ctx.daemon.answer('agents.list', {
    agents: [
      buildMockListedAgent({ id: 'claude', installed: true, capabilities: { spawn: true } }),
      buildMockListedAgent({ id: 'grok' }),
      buildMockListedAgent({ id: 'codex' }),
    ],
    targets: [
      {
        id: 'local',
        provider: 'local-pty',
        available: true,
        default: true,
        capabilities: { transfer: true, run: true },
      },
    ],
    sources: [{ id: 'github', label: 'GitHub repository', kind: 'git' }],
  });

  await ctx.daemon.answer('sources.list', {
    candidates: [{ label: 'acme/app', pick: { kind: 'git', url: 'git@github.com:acme/app.git' } }],
    scope: 'acme',
  });

  picker.applyKey(Buffer.from('zeta-org/'));
  picker.applyKey(Buffer.from(KEYS.enter));

  await ctx.daemon.answer('sources.interpret', { kind: 'browse', scope: 'zeta-org' });

  await ctx.daemon.answer('sources.list', {
    candidates: [
      { label: 'zeta-org/tool', pick: { kind: 'git', url: 'git@github.com:zeta-org/tool.git' } },
    ],
    scope: 'zeta-org',
  });

  picker.applyKey(Buffer.from(KEYS.ctrlRightBracket));
  picker.open();

  await ctx.daemon.answer('agents.list', {
    agents: [
      buildMockListedAgent({ id: 'claude', installed: true, capabilities: { spawn: true } }),
      buildMockListedAgent({ id: 'grok' }),
      buildMockListedAgent({ id: 'codex' }),
    ],
    targets: [
      {
        id: 'local',
        provider: 'local-pty',
        available: true,
        default: true,
        capabilities: { transfer: true, run: true },
      },
    ],
    sources: [{ id: 'github', label: 'GitHub repository', kind: 'git' }],
  });

  await ctx.daemon.answer('sources.list', {
    candidates: [{ label: 'acme/app', pick: { kind: 'git', url: 'git@github.com:acme/app.git' } }],
    scope: 'acme',
  });

  picker.applyKey(Buffer.from('zeta-org/'));
  picker.applyKey(Buffer.from(KEYS.enter));

  const mark = ctx.terminal.countChunks();

  await ctx.daemon.answer('sources.interpret', { kind: 'browse', scope: 'zeta-org' });

  const shown = ctx.terminal.getTextSince(mark);

  expect(shown).toInclude('spawn: GitHub repository · zeta-org · under 1m old, refreshing…');
  expect(shown).toInclude('zeta-org/tool');
});

test('it reads typed github:owner/repo text the cached listing leaves out through the source', async () => {
  const ctx = setupTest();

  const picker = new SpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    getLastUsedAgent: () => 'claude',
    listingCache: openListingCache(join(ctx.cwd, 'listing-cache.json')),
    getDaemonSocketPath: () => '/run/atc/atc.sock',
  });

  picker.open();

  await ctx.daemon.answer('agents.list', {
    agents: [
      buildMockListedAgent({ id: 'claude', installed: true, capabilities: { spawn: true } }),
      buildMockListedAgent({ id: 'grok' }),
      buildMockListedAgent({ id: 'codex' }),
    ],
    targets: [
      {
        id: 'local',
        provider: 'local-pty',
        available: true,
        default: true,
        capabilities: { transfer: true, run: true },
      },
    ],
    sources: [{ id: 'github', label: 'GitHub repository', kind: 'git' }],
  });

  await ctx.daemon.answer('sources.list', {
    candidates: [{ label: 'acme/app', pick: { kind: 'git', url: 'git@github.com:acme/app.git' } }],
    scope: 'acme',
  });

  picker.applyKey(Buffer.from(KEYS.ctrlRightBracket));
  picker.open();

  await ctx.daemon.answer('agents.list', {
    agents: [
      buildMockListedAgent({ id: 'claude', installed: true, capabilities: { spawn: true } }),
      buildMockListedAgent({ id: 'grok' }),
      buildMockListedAgent({ id: 'codex' }),
    ],
    targets: [
      {
        id: 'local',
        provider: 'local-pty',
        available: true,
        default: true,
        capabilities: { transfer: true, run: true },
      },
    ],
    sources: [{ id: 'github', label: 'GitHub repository', kind: 'git' }],
  });

  picker.applyKey(Buffer.from('github:zeta-org/zeta'));
  picker.applyKey(Buffer.from(KEYS.enter));

  expect(ctx.daemon.collectSent('sources.interpret')).toStrictEqual([
    { source: 'github', input: 'github:zeta-org/zeta', target: 'local' },
  ]);
});

test("it drops a remote daemon's completion of input typed over since, keeping the later completion", async () => {
  const ctx = setupTest();

  const picker = new SpawnPicker({
    ...ctx.deps,
    remoteDaemon: true,
    ptyRows: () => 24,
    getLastUsedAgent: () => 'claude',
  });

  picker.open();

  await ctx.daemon.answer('agents.list', {
    agents: [
      buildMockListedAgent({ id: 'claude', installed: true, capabilities: { spawn: true } }),
      buildMockListedAgent({ id: 'grok' }),
      buildMockListedAgent({ id: 'codex' }),
    ],
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

  picker.applyKey(Buffer.from('~/a'));
  ctx.clock.advance(120);
  picker.applyKey(Buffer.from('b'));
  ctx.clock.advance(120);

  await ctx.daemon.answer('sources.complete', {
    completions: [{ label: '~/ab-box', pick: { kind: 'path', directory: '/home/far/ab-box' } }],
  });

  await ctx.daemon.answerOldest('sources.complete', {
    completions: [{ label: '~/a-box', pick: { kind: 'path', directory: '/home/far/a-box' } }],
  });

  const mark = ctx.terminal.countChunks();

  picker.applyKey(Buffer.from(KEYS.enter));

  expect(ctx.dropped).toStrictEqual(['path completion']);
  expect(ctx.terminal.getTextSince(mark)).toInclude('spawn: name');

  expect(ctx.daemon.collectSent('sources.complete')).toStrictEqual([
    { source: 'dirs', input: '~/a', target: 'local' },
    { source: 'dirs', input: '~/ab', target: 'local' },
  ]);
});

test('it keeps the latest completion when an earlier one answers for input typed again since', async () => {
  const ctx = setupTest();

  const picker = new SpawnPicker({
    ...ctx.deps,
    remoteDaemon: true,
    ptyRows: () => 24,
    getLastUsedAgent: () => 'claude',
  });

  picker.open();

  await ctx.daemon.answer('agents.list', {
    agents: [
      buildMockListedAgent({ id: 'claude', installed: true, capabilities: { spawn: true } }),
      buildMockListedAgent({ id: 'grok' }),
      buildMockListedAgent({ id: 'codex' }),
    ],
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

  picker.applyKey(Buffer.from('~/a'));
  ctx.clock.advance(120);
  picker.applyKey(Buffer.from('b'));
  picker.applyKey(Buffer.from(KEYS.backspace));
  ctx.clock.advance(120);

  await ctx.daemon.answer('sources.complete', {
    completions: [{ label: '~/a-new', pick: { kind: 'path', directory: '/home/far/a-new' } }],
  });

  await ctx.daemon.answerOldest('sources.complete', {
    completions: [{ label: '~/a-old', pick: { kind: 'path', directory: '/home/far/a-old' } }],
  });

  picker.applyKey(Buffer.from(KEYS.enter));
  picker.applyKey(Buffer.from(`far-one${KEYS.enter}`));
  picker.applyKey(Buffer.from(KEYS.enter));

  expect(ctx.dropped).toStrictEqual(['path completion']);
  expect(ctx.daemon.collectSent('session.spawn')).toPartiallyContain({ cwd: '/home/far/a-new' });
});

test('it spawns in the directory a remote daemon completed', async () => {
  const ctx = setupTest();

  const picker = new SpawnPicker({
    ...ctx.deps,
    remoteDaemon: true,
    ptyRows: () => 24,
    getLastUsedAgent: () => 'claude',
  });

  picker.open();

  await ctx.daemon.answer('agents.list', {
    agents: [
      buildMockListedAgent({ id: 'claude', installed: true, capabilities: { spawn: true } }),
      buildMockListedAgent({ id: 'grok' }),
      buildMockListedAgent({ id: 'codex' }),
    ],
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

  picker.applyKey(Buffer.from('~/ab'));
  ctx.clock.advance(120);

  await ctx.daemon.answer('sources.complete', {
    completions: [{ label: '~/ab-box', pick: { kind: 'path', directory: '/home/far/ab-box' } }],
  });

  picker.applyKey(Buffer.from(KEYS.enter));
  picker.applyKey(Buffer.from(`far-one${KEYS.enter}`));
  picker.applyKey(Buffer.from(KEYS.enter));

  expect(ctx.daemon.collectSent('session.spawn')).toPartiallyContain({
    cwd: '/home/far/ab-box',
    name: 'far-one',
  });
});

test('it asks the daemon once for a path typed in a burst of keys', async () => {
  const ctx = setupTest();

  const picker = new SpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    getLastUsedAgent: () => 'claude',
  });

  picker.open();

  await ctx.daemon.answer('agents.list', {
    agents: [
      buildMockListedAgent({ id: 'claude', installed: true, capabilities: { spawn: true } }),
      buildMockListedAgent({ id: 'grok' }),
      buildMockListedAgent({ id: 'codex' }),
    ],
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

  picker.applyKey(Buffer.from('.'));
  ctx.clock.advance(119);
  picker.applyKey(Buffer.from('/'));
  ctx.clock.advance(119);
  picker.applyKey(Buffer.from('w'));
  ctx.clock.advance(120);

  expect(ctx.daemon.collectSent('sources.complete')).toStrictEqual([
    { source: 'dirs', input: './w', clientCwd: ctx.cwd },
  ]);
});

test("it spawns in the directory a local daemon completed under the client's directory", async () => {
  const ctx = setupTest();

  const picker = new SpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    getLastUsedAgent: () => 'claude',
  });

  picker.open();

  await ctx.daemon.answer('agents.list', {
    agents: [
      buildMockListedAgent({ id: 'claude', installed: true, capabilities: { spawn: true } }),
      buildMockListedAgent({ id: 'grok' }),
      buildMockListedAgent({ id: 'codex' }),
    ],
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

  picker.applyKey(Buffer.from('./we'));
  ctx.clock.advance(120);

  await ctx.daemon.answer('sources.complete', {
    completions: [{ label: '~/web', pick: { kind: 'path', directory: '/srv/near/web' } }],
  });

  picker.applyKey(Buffer.from(KEYS.enter));
  picker.applyKey(Buffer.from(`near-one${KEYS.enter}`));
  picker.applyKey(Buffer.from(KEYS.enter));

  expect(ctx.daemon.collectSent('sources.complete')).toStrictEqual([
    { source: 'dirs', input: './we', clientCwd: ctx.cwd },
  ]);

  expect(ctx.daemon.collectSent('session.spawn')).toPartiallyContain({ cwd: '/srv/near/web' });
});

test("it asks a local daemon to read a typed relative path under the client's directory", async () => {
  const ctx = setupTest();

  const picker = new SpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    getLastUsedAgent: () => 'claude',
  });

  picker.open();

  await ctx.daemon.answer('agents.list', {
    agents: [
      buildMockListedAgent({ id: 'claude', installed: true, capabilities: { spawn: true } }),
      buildMockListedAgent({ id: 'grok' }),
      buildMockListedAgent({ id: 'codex' }),
    ],
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

  picker.applyKey(Buffer.from(`./new-work${KEYS.enter}`));

  await ctx.daemon.answer('sources.interpret', { kind: 'path', directory: '/srv/near/new-work' });

  picker.applyKey(Buffer.from(`near-two${KEYS.enter}`));
  picker.applyKey(Buffer.from(KEYS.enter));

  expect(ctx.daemon.collectSent('sources.interpret')).toStrictEqual([
    { source: 'dirs', input: './new-work', clientCwd: ctx.cwd },
  ]);

  expect(ctx.daemon.collectSent('session.spawn')).toPartiallyContain({
    cwd: '/srv/near/new-work',
  });
});

test("it shows a remote daemon's refused completion in place of the hint", async () => {
  const ctx = setupTest();

  const picker = new SpawnPicker({
    ...ctx.deps,
    remoteDaemon: true,
    ptyRows: () => 24,
    getLastUsedAgent: () => 'claude',
  });

  picker.open();

  await ctx.daemon.answer('agents.list', {
    agents: [
      buildMockListedAgent({ id: 'claude', installed: true, capabilities: { spawn: true } }),
      buildMockListedAgent({ id: 'grok' }),
      buildMockListedAgent({ id: 'codex' }),
    ],
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

  picker.applyKey(Buffer.from('~/a'));
  ctx.clock.advance(120);

  const mark = ctx.terminal.countChunks();

  await ctx.daemon.refuse(
    'sources.complete',
    new DaemonError('target_forbidden', 'target local is not yours'),
  );

  expect(ctx.terminal.getTextSince(mark)).toInclude(
    'cannot complete ~/a: target_forbidden: target local is not yours',
  );
});

test('it spawns in the directory a remote daemon reads a typed ~ path as when nothing completes it', async () => {
  const ctx = setupTest();

  const picker = new SpawnPicker({
    ...ctx.deps,
    remoteDaemon: true,
    ptyRows: () => 24,
    getLastUsedAgent: () => 'claude',
  });

  picker.open();

  await ctx.daemon.answer('agents.list', {
    agents: [
      buildMockListedAgent({ id: 'claude', installed: true, capabilities: { spawn: true } }),
      buildMockListedAgent({ id: 'grok' }),
      buildMockListedAgent({ id: 'codex' }),
    ],
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

  picker.applyKey(Buffer.from('~/work'));
  ctx.clock.advance(120);

  await ctx.daemon.answer('sources.complete', { completions: [] });

  picker.applyKey(Buffer.from(KEYS.enter));

  await ctx.daemon.answer('sources.interpret', { kind: 'path', directory: '/home/far/work' });

  picker.applyKey(Buffer.from(`far-one${KEYS.enter}`));
  picker.applyKey(Buffer.from(KEYS.enter));

  expect(ctx.daemon.collectSent('sources.interpret')).toStrictEqual([
    { source: 'dirs', input: '~/work', target: 'local' },
  ]);

  expect(ctx.daemon.collectSent('session.spawn')).toPartiallyContain({ cwd: '/home/far/work' });
});

test("it shows a remote daemon's refusal to read a typed ~ path", async () => {
  const ctx = setupTest();

  const picker = new SpawnPicker({
    ...ctx.deps,
    remoteDaemon: true,
    ptyRows: () => 24,
    getLastUsedAgent: () => 'claude',
  });

  picker.open();

  await ctx.daemon.answer('agents.list', {
    agents: [
      buildMockListedAgent({ id: 'claude', installed: true, capabilities: { spawn: true } }),
      buildMockListedAgent({ id: 'grok' }),
      buildMockListedAgent({ id: 'codex' }),
    ],
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

  picker.applyKey(Buffer.from('~/work'));
  ctx.clock.advance(120);

  await ctx.daemon.answer('sources.complete', { completions: [] });

  picker.applyKey(Buffer.from(KEYS.enter));

  const mark = ctx.terminal.countChunks();

  await ctx.daemon.refuse(
    'sources.interpret',
    new DaemonError('target_forbidden', 'target local is not yours'),
  );

  expect(ctx.terminal.getTextSince(mark)).toInclude(
    'cannot read ~/work: target_forbidden: target local',
  );
});

test('it names the one target a remote principal may use in its directory requests', async () => {
  const ctx = setupTest();

  const picker = new SpawnPicker({
    ...ctx.deps,
    remoteDaemon: true,
    ptyRows: () => 24,
    getLastUsedAgent: () => 'claude',
  });

  picker.open();

  await ctx.daemon.answer('agents.list', {
    agents: [
      buildMockListedAgent({ id: 'claude', installed: true, capabilities: { spawn: true } }),
      buildMockListedAgent({ id: 'grok' }),
      buildMockListedAgent({ id: 'codex' }),
    ],
    targets: [
      {
        id: 'box',
        provider: 'local-pty',
        available: true,
        default: false,
        capabilities: { transfer: true, run: true },
      },
    ],
    sources: [{ id: 'dirs', label: 'directory on the daemon host', kind: 'path' }],
  });

  await ctx.daemon.answer('sources.list', { source: 'dirs', scope: null, candidates: [] });

  picker.applyKey(Buffer.from('/srv/work'));
  ctx.clock.advance(120);

  expect(ctx.daemon.collectSent('sources.list')).toStrictEqual([{ source: 'dirs', target: 'box' }]);

  expect(ctx.daemon.collectSent('sources.complete')).toStrictEqual([
    { source: 'dirs', input: '/srv/work', target: 'box' },
  ]);
});

test("it shows why a remote daemon's directory listing failed", async () => {
  const ctx = setupTest();

  const picker = new SpawnPicker({
    ...ctx.deps,
    remoteDaemon: true,
    ptyRows: () => 24,
    getLastUsedAgent: () => 'claude',
  });

  picker.open();

  await ctx.daemon.answer('agents.list', {
    agents: [
      buildMockListedAgent({ id: 'claude', installed: true, capabilities: { spawn: true } }),
      buildMockListedAgent({ id: 'grok' }),
      buildMockListedAgent({ id: 'codex' }),
    ],
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

  const mark = ctx.terminal.countChunks();

  await ctx.daemon.refuse(
    'sources.list',
    new DaemonError('target_forbidden', 'target local is not yours'),
  );

  expect(ctx.terminal.getTextSince(mark)).toInclude(
    'cannot list directories: target_forbidden: target local is not yours',
  );
});
