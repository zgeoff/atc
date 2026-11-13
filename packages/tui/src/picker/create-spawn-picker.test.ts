import { expect, test } from 'bun:test';
import { parseConfig } from '@atc/config';
import { DaemonError } from '@atc/protocol/wire';
import {
  KEYS,
  buildMockListedAgent,
  buildMockSessionDescriptor,
  buildStubClock,
  buildStubDaemonRequests,
  buildStubHarnessPlugins,
  buildStubTerminal,
} from '@atc/test-utils';
import { toSessionID } from '@atcx/contract';
import { resolveHomeDir } from '@atcx/contract/light';
import type { DaemonName } from '../session-key';
import {
  buildStubListingCache,
  buildStubListingCacheOf,
} from '../testing/build-stub-listing-cache';
import { buildStubPickerHost } from '../testing/build-stub-picker-host';
import { toMirrorSession } from '../to-mirror-session';
import { createSpawnPicker } from './create-spawn-picker';

function setupTest() {
  // the directory filter fuzzy-matches every typed character in order, so no letter a
  // filter such as `acme/` needs follows the last separator of the client's directory.
  const cwd = '/srv/atc-spawn-picker/client';
  const host = buildStubPickerHost();
  const terminal = buildStubTerminal();
  const daemon = buildStubDaemonRequests({ countReactions: host.countReactions });
  const clock = buildStubClock(1_000_000_000);

  const deps = {
    primaryDaemon: null,
    upDaemons: () => [null],
    sendRequest: (
      _daemon: DaemonName,
      method: string,
      params?: Readonly<Record<string, unknown>>,
    ) => daemon.sendRequest(method, params),
    isLeaderKey: (buf: Buffer) => buf.toString() === KEYS.ctrlRightBracket,
    scheduleStatus: host.scheduleStatus,
    showBase: host.showBase,
    attach: host.attach,
    toMirrorSession: (owner: DaemonName, value: unknown) => toMirrorSession(value, owner),
    upsertMirror: () => {},
    write: terminal.write,
    cwd,
    home: resolveHomeDir(),
    readConfig: () => parseConfig(buildStubHarnessPlugins(), {}),
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
    clock,
  };
}

test('it drops the agent list that arrives after esc leaves the agent step', async () => {
  const ctx = setupTest();

  const picker = createSpawnPicker({
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

  const picker = createSpawnPicker({
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

  expect(shown).toInclude('the daemon offers no sources · set sources · esc cancel');
  expect(shown).not.toInclude(ctx.cwd);
  expect(ctx.daemon.collectSent('dirs.list')).toStrictEqual([]);
  expect(ctx.daemon.collectSent('sources.list')).toStrictEqual([]);
});

test('it refuses an adopt on a daemon that offers no source of directories', async () => {
  const ctx = setupTest();

  const picker = createSpawnPicker({
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
    'no directory source to adopt in · set sources · esc cancel',
  );

  expect(ctx.daemon.collectSent('dirs.list')).toStrictEqual([]);
  expect(ctx.daemon.collectSent('sources.list')).toStrictEqual([]);
});

test('it leaves the flow on esc from the refusal of a daemon that offers no sources', async () => {
  const ctx = setupTest();

  const picker = createSpawnPicker({
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

  const picker = createSpawnPicker({
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

  const picker = createSpawnPicker({
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

  const picker = createSpawnPicker({
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

  const picker = createSpawnPicker({
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

  await ctx.daemon.answer('sources.interpret', { kind: 'git', url: 'https://example.com/app.git' });

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

test('it refuses a typed ref whose probe answer the probe schema rejects', async () => {
  const ctx = setupTest();

  const picker = createSpawnPicker({
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

  picker.applyKey(Buffer.from(`https://example.com/app.git${KEYS.enter}`));

  await ctx.daemon.answer('sources.interpret', { kind: 'git', url: 'https://example.com/app.git' });

  await ctx.daemon.answer('git.probe', {
    url: 'https://example.com/app.git',
    head: 'main',
    refs: [{ name: 'main', kind: 'branch', sha: 'a'.repeat(40) }],
    resolved: null,
  });

  picker.applyKey(Buffer.from(`refs/tags/v9${KEYS.enter}`));

  const mark = ctx.terminal.countChunks();

  await ctx.daemon.answer('git.probe', { resolved: { sha: 'abc' } });

  const shown = ctx.terminal.getTextSince(mark);

  expect(shown).toInclude('the daemon answered git.probe with a malformed result');
  expect(shown).not.toInclude('spawn: confirm');
});

test('it keeps a git listing running while the step waits on a probe', async () => {
  const ctx = setupTest();

  const picker = createSpawnPicker({
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

  picker.applyKey(Buffer.from('https://example.com/app.git'));
  picker.applyKey(Buffer.from(KEYS.enter));

  await ctx.daemon.answer('sources.interpret', { kind: 'git', url: 'https://example.com/app.git' });

  const mark = ctx.terminal.countChunks();

  await ctx.daemon.answer('sources.list', {
    source: 'fake',
    scope: 'octo',
    candidates: [
      {
        label: 'octo/app',
        pick: { kind: 'git', url: 'https://example.com/octo/app.git' },
      },
    ],
  });

  expect(ctx.dropped).toStrictEqual([]);
  expect(ctx.terminal.getTextSince(mark)).toInclude('spawn: workspace · fake: octo');
});

test('it neither attaches nor draws a spawn that answers after esc stops waiting on it', async () => {
  const ctx = setupTest();

  const picker = createSpawnPicker({
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

  const picker = createSpawnPicker({
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

  const picker = createSpawnPicker({
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

  await ctx.daemon.answer('sources.interpret', { kind: 'git', url: 'https://example.com/app.git' });

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

  const picker = createSpawnPicker({
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

  await ctx.daemon.answer('sources.interpret', { kind: 'git', url: 'https://example.com/app.git' });

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

  const picker = createSpawnPicker({
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

  await ctx.daemon.answer('sources.interpret', { kind: 'git', url: 'https://example.com/app.git' });

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

  const picker = createSpawnPicker({
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

  const picker = createSpawnPicker({
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

  const picker = createSpawnPicker({
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

  const picker = createSpawnPicker({
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

  const picker = createSpawnPicker({
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

  const picker = createSpawnPicker({
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

  const picker = createSpawnPicker({
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

  const picker = createSpawnPicker({
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

  const picker = createSpawnPicker({
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

  const picker = createSpawnPicker({
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

  const picker = createSpawnPicker({
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

test('it lists a scope read from typed text once, on the listing target', async () => {
  const ctx = setupTest();

  const picker = createSpawnPicker({
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

  picker.applyKey(Buffer.from('acme/'));
  picker.applyKey(Buffer.from(KEYS.enter));

  await ctx.daemon.answer('sources.interpret', { kind: 'browse', scope: 'acme' });

  expect(ctx.daemon.collectSent('sources.list')).toStrictEqual([
    { source: 'dirs' },
    { source: 'fake', target: 'local' },
    { source: 'fake', scope: 'acme', target: 'local' },
  ]);
});

test('it starts a new flow on the default target, not the one the last flow chose', async () => {
  const ctx = setupTest();

  const picker = createSpawnPicker({
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

test('it stops every listing on esc to the agent step and lists every source again on the next pick', async () => {
  const ctx = setupTest();

  const picker = createSpawnPicker({
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
  picker.applyKey(Buffer.from(KEYS.esc));
  picker.applyKey(Buffer.from(KEYS.enter));

  await ctx.daemon.answerOldest('sources.list', { scope: null, candidates: [] });
  await ctx.daemon.answerOldest('sources.list', { scope: null, candidates: [] });

  expect(ctx.dropped).toStrictEqual(['listing', 'directory listing']);

  expect(ctx.daemon.collectSent('sources.list')).toStrictEqual([
    { source: 'fake', target: 'local' },
    { source: 'dirs' },
    { source: 'fake', target: 'local' },
    { source: 'dirs' },
  ]);
});

test('it asks the daemon for its agents as it opens', () => {
  const ctx = setupTest();

  const picker = createSpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    getLastUsedAgent: () => 'claude',
  });

  picker.open();

  expect(ctx.daemon.collectSent('agents.list')).toStrictEqual([{}]);
});

test('it leaves an agent the daemon lists as not installed or unable to spawn out of the menu', async () => {
  const ctx = setupTest();

  const picker = createSpawnPicker({
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

test('it leaves out of the menu an agent entry the agent schema rejects', async () => {
  const ctx = setupTest();

  const picker = createSpawnPicker({
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
      {
        ...buildMockListedAgent({
          id: 'grok',
          label: 'Garbled Grok',
          installed: true,
          capabilities: { spawn: true },
        }),
        installed: 'yes',
      },
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
  expect(shown).not.toInclude('Garbled Grok');
});

test('it opens the first source without a menu when the daemon can start one agent', async () => {
  const ctx = setupTest();

  const picker = createSpawnPicker({
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

  const picker = createSpawnPicker({
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

  const picker = createSpawnPicker({
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

  const picker = createSpawnPicker({
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

test('it returns esc from the list to the agent step when more than one agent is installed', async () => {
  const ctx = setupTest();

  const picker = createSpawnPicker({
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

test('it leaves the flow on esc from the list when one agent is installed', async () => {
  const ctx = setupTest();

  const picker = createSpawnPicker({
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

  const picker = createSpawnPicker({
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

test("it shows the client's directory under the home the client passes, not the process home", async () => {
  const ctx = setupTest();

  const picker = createSpawnPicker({
    ...ctx.deps,
    home: '/srv/atc-spawn-picker',
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
    sources: [{ id: 'dirs', label: 'directory on the daemon host', kind: 'path' }],
  });

  expect(ctx.terminal.getTextSince(mark)).toInclude('\u001B[7m~/client');
});

test('it names the chosen directory under the home the client passes on the name step', async () => {
  const ctx = setupTest();

  const picker = createSpawnPicker({
    ...ctx.deps,
    home: '/srv/atc-spawn-picker',
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

  expect(ctx.terminal.getTextSince(mark)).toInclude('session name for ~/client');
});

test('it names the chosen directory under the home the client passes on the target step', async () => {
  const ctx = setupTest();

  const picker = createSpawnPicker({
    ...ctx.deps,
    home: '/srv/atc-spawn-picker',
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
        provider: 'local-pty',
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

  expect(ctx.terminal.getTextSince(mark)).toInclude('where ~/client runs');
});

test('it returns esc from the name step to the list when one target left no choice', async () => {
  const ctx = setupTest();

  const picker = createSpawnPicker({
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

  expect(ctx.terminal.getTextSince(mark)).toInclude('spawn: workspace');
  expect(ctx.counts.exits).toBe(0);
});

test('it lists a git source for the one target without a key when one agent and one target leave no choice', async () => {
  const ctx = setupTest();

  const picker = createSpawnPicker({
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

  const picker = createSpawnPicker({
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

  const picker = createSpawnPicker({
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

  const picker = createSpawnPicker({
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

  const picker = createSpawnPicker({
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

  const picker = createSpawnPicker({
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

test('it shows a git source as skipped and lists only the directories when no target takes a workspace', async () => {
  const ctx = setupTest();

  const picker = createSpawnPicker({
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
    sources: [
      { id: 'dirs', label: 'directory on the daemon host', kind: 'path' },
      { id: 'github', label: 'GitHub repository', kind: 'git' },
    ],
  });

  expect(ctx.terminal.getText()).toInclude('github: no target takes a workspace');
  expect(ctx.daemon.collectSent('sources.list')).toStrictEqual([{ source: 'dirs' }]);
});

test('it shows why no target can run an agent whose broker no target reaches', async () => {
  const ctx = setupTest();

  const picker = createSpawnPicker({
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

  const picker = createSpawnPicker({
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

test('it returns esc from a target step with no usable target to the list', async () => {
  const ctx = setupTest();

  const picker = createSpawnPicker({
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

  expect(ctx.terminal.getTextSince(mark)).toInclude('spawn: workspace');
  expect(ctx.counts.exits).toBe(0);
});

test('it drops the agent list of a flow that was left and opened again', async () => {
  const ctx = setupTest();

  const picker = createSpawnPicker({
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

  const picker = createSpawnPicker({
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
  const cache = buildStubListingCache();

  const earlier = createSpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    getLastUsedAgent: () => 'claude',
    getListingCache: () => cache,
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

  const picker = createSpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    getLastUsedAgent: () => 'claude',
    getListingCache: () => cache,
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

  expect(shown).toInclude('spawn: workspace · github: acme · 5m old, refreshing…');
  expect(shown).toInclude('acme/app');

  expect(ctx.daemon.collectSent('sources.list')).toStrictEqual([
    { source: 'github', target: 'local' },
    { source: 'github', target: 'local' },
  ]);
});

test('it swaps the fresh listing in for the cached one when it answers, keeping the selected repository', async () => {
  const ctx = setupTest();

  const picker = createSpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    getLastUsedAgent: () => 'claude',
    getListingCache: buildStubListingCacheOf(),
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

test('it picks a repository listed past the tenth row', async () => {
  const ctx = setupTest();

  const picker = createSpawnPicker({
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
    sources: [{ id: 'github', label: 'GitHub repository', kind: 'git' }],
  });

  await ctx.daemon.answer('sources.list', {
    candidates: Array.from({ length: 12 }, (_, index) => ({
      label: `acme/tool-${index + 1}`,
      pick: { kind: 'git', url: `git@github.com:acme/tool-${index + 1}.git` },
    })),
    scope: 'acme',
  });

  for (let press = 0; press < 11; press += 1) {
    picker.applyKey(Buffer.from(KEYS.down));
  }

  picker.applyKey(Buffer.from(KEYS.enter));

  expect(ctx.daemon.collectSent('git.probe')).toStrictEqual([
    { url: 'git@github.com:acme/tool-12.git', target: 'local' },
  ]);
});

test('it spawns in a directory listed past the tenth row', async () => {
  const ctx = setupTest();

  const picker = createSpawnPicker({
    ...ctx.deps,
    primaryDaemon: 'box',
    upDaemons: () => ['box'],
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

  await ctx.daemon.answer('sources.list', {
    source: 'dirs',
    scope: null,
    candidates: Array.from({ length: 12 }, (_, index) => ({
      label: `~/work/site-${index + 1}`,
      pick: { kind: 'path', directory: `/home/far/work/site-${index + 1}` },
    })),
  });

  for (let press = 0; press < 11; press += 1) {
    picker.applyKey(Buffer.from(KEYS.down));
  }

  picker.applyKey(Buffer.from(KEYS.enter));
  picker.applyKey(Buffer.from(`far-one${KEYS.enter}`));
  picker.applyKey(Buffer.from(KEYS.enter));

  expect(ctx.daemon.collectSent('session.spawn')).toPartiallyContain({
    cwd: '/home/far/work/site-12',
  });
});

test('it spawns a repository at a ref listed past the tenth row', async () => {
  const ctx = setupTest();

  const picker = createSpawnPicker({
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

  await ctx.daemon.answer('sources.interpret', { kind: 'git', url: 'https://example.com/app.git' });

  await ctx.daemon.answer('git.probe', {
    url: 'https://example.com/app.git',
    head: 'release-1',
    refs: Array.from({ length: 12 }, (_, index) => ({
      name: `release-${index + 1}`,
      kind: 'branch',
      sha: `${index + 1}`.padStart(40, '0'),
    })),
    resolved: null,
  });

  for (let press = 0; press < 11; press += 1) {
    picker.applyKey(Buffer.from(KEYS.down));
  }

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
        ref: 'release-12',
        sha: '12'.padStart(40, '0'),
      },
    },
  ]);
});

test('it lists again on ctrl-r and shows a repository created since the last listing', async () => {
  const ctx = setupTest();

  const picker = createSpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    getLastUsedAgent: () => 'claude',
    getListingCache: buildStubListingCacheOf(),
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

  const picker = createSpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    getLastUsedAgent: () => 'claude',
    getListingCache: buildStubListingCacheOf(),
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

  expect(shown).toInclude('github: listing…');
  expect(shown).not.toInclude('acme/app');
});

test('it keeps the cached listing with the failure in its hint when listing again fails', async () => {
  const ctx = setupTest();

  const picker = createSpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    getLastUsedAgent: () => 'claude',
    getListingCache: buildStubListingCacheOf(),
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

test('it leaves the list on esc while it refreshes a cached listing', async () => {
  const ctx = setupTest();

  const picker = createSpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    getLastUsedAgent: () => 'claude',
    getListingCache: buildStubListingCacheOf(),
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

  const picker = createSpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    getLastUsedAgent: () => 'claude',
    getListingCache: buildStubListingCacheOf(),
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

  const picker = createSpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    getLastUsedAgent: () => 'claude',
    getListingCache: buildStubListingCacheOf(),
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

test('it shows the cached listing of an owner typed on the list at once, while it lists that owner again', async () => {
  const ctx = setupTest();

  const picker = createSpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    getLastUsedAgent: () => 'claude',
    getListingCache: buildStubListingCacheOf(),
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

  expect(shown).toInclude('spawn: workspace · github: zeta-org · under 1m old, refreshing…');
  expect(shown).toInclude('github:zeta-org/tool');
});

test('it reads typed github:owner/repo text the cached listing leaves out through the source', async () => {
  const ctx = setupTest();

  const picker = createSpawnPicker({
    ...ctx.deps,
    ptyRows: () => 24,
    getLastUsedAgent: () => 'claude',
    getListingCache: buildStubListingCacheOf(),
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

  const picker = createSpawnPicker({
    ...ctx.deps,
    primaryDaemon: 'box',
    upDaemons: () => ['box'],
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

  const picker = createSpawnPicker({
    ...ctx.deps,
    primaryDaemon: 'box',
    upDaemons: () => ['box'],
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

  const picker = createSpawnPicker({
    ...ctx.deps,
    primaryDaemon: 'box',
    upDaemons: () => ['box'],
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

  const picker = createSpawnPicker({
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

test('it sends no completion for a path typed just before the leader leaves the flow', async () => {
  const ctx = setupTest();

  const picker = createSpawnPicker({
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

  picker.applyKey(Buffer.from('./w'));
  ctx.clock.advance(60);
  picker.applyKey(Buffer.from(KEYS.ctrlRightBracket));
  ctx.clock.advance(120);

  expect(ctx.daemon.collectSent('sources.complete')).toStrictEqual([]);
});

test("it spawns in the directory a local daemon completed under the client's directory", async () => {
  const ctx = setupTest();

  const picker = createSpawnPicker({
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

  const picker = createSpawnPicker({
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

test('it names the target of a local typed path when the daemon lists no default target', async () => {
  const ctx = setupTest();

  const picker = createSpawnPicker({
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
        provider: 'local-pty',
        available: true,
        default: false,
        capabilities: { transfer: true, run: true },
      },
    ],
    sources: [{ id: 'dirs', label: 'directory on the daemon host', kind: 'path' }],
  });

  await ctx.daemon.answer('sources.list', { source: 'dirs', scope: null, candidates: [] });

  picker.applyKey(Buffer.from(`/srv/box-app${KEYS.enter}`));

  await ctx.daemon.answer('sources.interpret', { kind: 'path', directory: '/srv/box-app' });

  expect(ctx.daemon.collectSent('sources.interpret')).toStrictEqual([
    { source: 'dirs', input: '/srv/box-app', target: 'box', clientCwd: ctx.cwd },
  ]);
});

test("it shows a remote daemon's refused completion in place of the hint", async () => {
  const ctx = setupTest();

  const picker = createSpawnPicker({
    ...ctx.deps,
    primaryDaemon: 'box',
    upDaemons: () => ['box'],
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

  const picker = createSpawnPicker({
    ...ctx.deps,
    primaryDaemon: 'box',
    upDaemons: () => ['box'],
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

  const picker = createSpawnPicker({
    ...ctx.deps,
    primaryDaemon: 'box',
    upDaemons: () => ['box'],
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

  const picker = createSpawnPicker({
    ...ctx.deps,
    primaryDaemon: 'box',
    upDaemons: () => ['box'],
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

  const picker = createSpawnPicker({
    ...ctx.deps,
    primaryDaemon: 'box',
    upDaemons: () => ['box'],
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
    'dirs: target_forbidden: target local is not yours',
  );
});

test('it drops a path completion that arrives after esc leaves the list', async () => {
  const ctx = setupTest();

  const picker = createSpawnPicker({
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

  picker.applyKey(Buffer.from('~/a'));
  ctx.clock.advance(120);
  picker.applyKey(Buffer.from(KEYS.esc));

  const renders = ctx.counts.renders;
  const mark = ctx.terminal.countChunks();

  await ctx.daemon.answer('sources.complete', {
    completions: [{ label: '~/a-late', pick: { kind: 'path', directory: '/home/late/a-late' } }],
  });

  expect(ctx.dropped).toStrictEqual(['path completion']);
  expect(ctx.counts.renders).toBe(renders);
  expect(ctx.terminal.getTextSince(mark)).toBe('');
});

test('it moves tab to the first github row of the list without opening the target step', async () => {
  const ctx = setupTest();

  const picker = createSpawnPicker({
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
      { id: 'github', label: 'GitHub repository', kind: 'git' },
    ],
  });

  await ctx.daemon.answerOldest('sources.list', {
    candidates: [
      { label: '~/code/widgets', pick: { kind: 'path', directory: '/home/ada/code/widgets' } },
    ],
  });

  await ctx.daemon.answer('sources.list', {
    candidates: [
      {
        label: 'acme-tools/widgets',
        detail: 'private · the widget service',
        pick: { kind: 'git', url: 'git@github.com:acme-tools/widgets.git' },
      },
    ],
  });

  const mark = ctx.terminal.countChunks();

  picker.applyKey(Buffer.from(KEYS.tab));

  const shown = ctx.terminal.getTextSince(mark);

  expect(shown).not.toInclude('spawn: target');
  expect(shown).toInclude('\u001B[7mgithub:acme-tools/widgets  private · the widget service');
});

test('it wraps tab from the last source back to the first', async () => {
  const ctx = setupTest();

  const picker = createSpawnPicker({
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
      { id: 'dirs', label: 'directory on the daemon host', kind: 'path' },
      { id: 'github', label: 'GitHub repository', kind: 'git' },
    ],
  });

  await ctx.daemon.answerOldest('sources.list', { candidates: [] });

  await ctx.daemon.answer('sources.list', {
    candidates: [
      {
        label: 'acme-tools/widgets',
        pick: { kind: 'git', url: 'git@github.com:acme-tools/widgets.git' },
      },
    ],
  });

  picker.applyKey(Buffer.from(KEYS.tab));

  const mark = ctx.terminal.countChunks();

  picker.applyKey(Buffer.from(KEYS.tab));

  expect(ctx.terminal.getTextSince(mark)).toInclude(`\u001B[7m${ctx.cwd}`);
});

test('it moves tab to the best match of the next source that matches the typed filter', async () => {
  const ctx = setupTest();

  const picker = createSpawnPicker({
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
      { id: 'dirs', label: 'directory on the daemon host', kind: 'path' },
      { id: 'gitlab', label: 'GitLab repository', kind: 'git' },
      { id: 'github', label: 'GitHub repository', kind: 'git' },
    ],
  });

  await ctx.daemon.answerOldest('sources.list', {
    candidates: [
      { label: '~/code/widgets', pick: { kind: 'path', directory: '/home/ada/code/widgets' } },
    ],
  });

  await ctx.daemon.answerOldest('sources.list', {
    candidates: [
      {
        label: 'harbor-labs/lamp',
        pick: { kind: 'git', url: 'git@gitlab.com:harbor-labs/lamp.git' },
      },
    ],
  });

  await ctx.daemon.answer('sources.list', {
    candidates: [
      {
        label: 'acme-tools/windowing',
        pick: { kind: 'git', url: 'git@github.com:acme-tools/windowing.git' },
      },
      {
        label: 'acme-tools/widgets',
        pick: { kind: 'git', url: 'git@github.com:acme-tools/widgets.git' },
      },
    ],
  });

  picker.applyKey(Buffer.from('widg'));

  const mark = ctx.terminal.countChunks();

  picker.applyKey(Buffer.from(KEYS.tab));

  expect(ctx.terminal.getTextSince(mark)).toInclude('\u001B[7mgithub:acme-tools/widgets');
});

test('it moves tab onto the listing row of a source still listing', async () => {
  const ctx = setupTest();

  const picker = createSpawnPicker({
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
      { id: 'dirs', label: 'directory on the daemon host', kind: 'path' },
      { id: 'github', label: 'GitHub repository', kind: 'git' },
    ],
  });

  await ctx.daemon.answerOldest('sources.list', { candidates: [] });

  const mark = ctx.terminal.countChunks();

  picker.applyKey(Buffer.from(KEYS.tab));

  expect(ctx.terminal.getTextSince(mark)).toInclude('\u001B[7mgithub: listing…');
});

test('it keeps tab from moving off the directories of an adopt', async () => {
  const ctx = setupTest();

  const picker = createSpawnPicker({
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
        id: 'local',
        provider: 'local-pty',
        available: true,
        default: true,
        capabilities: { transfer: true, run: true },
      },
    ],
    sources: [
      { id: 'dirs', label: 'directory on the daemon host', kind: 'path' },
      { id: 'github', label: 'GitHub repository', kind: 'git' },
    ],
  });

  await ctx.daemon.answer('sources.list', { candidates: [] });

  const renders = ctx.counts.renders;

  picker.applyKey(Buffer.from(KEYS.tab));

  expect(ctx.counts.renders).toBe(renders);
  expect(ctx.daemon.collectSent('sources.list')).toStrictEqual([{ source: 'dirs' }]);
});

test('it shows the directory rows and the github rows together and filters both by typed text', async () => {
  const ctx = setupTest();

  const picker = createSpawnPicker({
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
      { id: 'dirs', label: 'directory on the daemon host', kind: 'path' },
      { id: 'github', label: 'GitHub repository', kind: 'git' },
    ],
  });

  await ctx.daemon.answerOldest('sources.list', {
    candidates: [
      { label: '~/code/widgets', pick: { kind: 'path', directory: '/home/ada/code/widgets' } },
      { label: '~/code/lamp', pick: { kind: 'path', directory: '/home/ada/code/lamp' } },
    ],
  });

  await ctx.daemon.answer('sources.list', {
    candidates: [
      {
        label: 'acme-tools/widgets',
        pick: { kind: 'git', url: 'git@github.com:acme-tools/widgets.git' },
      },
      {
        label: 'acme-tools/gadgets',
        pick: { kind: 'git', url: 'git@github.com:acme-tools/gadgets.git' },
      },
    ],
  });

  const listed = ctx.terminal.getText();
  const mark = ctx.terminal.countChunks();

  picker.applyKey(Buffer.from('widg'));

  const filtered = ctx.terminal.getTextSince(mark);

  expect(listed).toIncludeMultiple([
    '~/code/widgets',
    '~/code/lamp',
    'github:acme-tools/widgets',
    'github:acme-tools/gadgets',
  ]);

  expect(filtered).toIncludeMultiple(['~/code/widgets', 'github:acme-tools/widgets']);
  expect(filtered).not.toInclude('~/code/lamp');
  expect(filtered).not.toInclude('github:acme-tools/gadgets');
});

test('it opens the target step on the listing target after enter on a github row, and probes on the target chosen there', async () => {
  const ctx = setupTest();

  const picker = createSpawnPicker({
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
      {
        label: 'acme-tools/widgets',
        pick: { kind: 'git', url: 'git@github.com:acme-tools/widgets.git' },
      },
    ],
  });

  const mark = ctx.terminal.countChunks();

  picker.applyKey(Buffer.from(KEYS.enter));

  const shown = ctx.terminal.getTextSince(mark);

  picker.applyKey(Buffer.from(KEYS.up));
  picker.applyKey(Buffer.from(KEYS.enter));

  expect(shown).toInclude('\u001B[7mlocal  local-pty · default');

  expect(ctx.daemon.collectSent('sources.list')).toStrictEqual([
    { source: 'github', target: 'local' },
  ]);

  expect(ctx.daemon.collectSent('git.probe')).toStrictEqual([
    { url: 'git@github.com:acme-tools/widgets.git', target: 'box' },
  ]);
});

test('it returns esc from the target step of a github row to the list with that row selected', async () => {
  const ctx = setupTest();

  const picker = createSpawnPicker({
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
    sources: [{ id: 'github', label: 'GitHub repository', kind: 'git' }],
  });

  await ctx.daemon.answer('sources.list', {
    candidates: [
      {
        label: 'acme-tools/gadgets',
        pick: { kind: 'git', url: 'git@github.com:acme-tools/gadgets.git' },
      },
      {
        label: 'acme-tools/widgets',
        pick: { kind: 'git', url: 'git@github.com:acme-tools/widgets.git' },
      },
    ],
  });

  picker.applyKey(Buffer.from(KEYS.down));
  picker.applyKey(Buffer.from(KEYS.enter));

  const mark = ctx.terminal.countChunks();

  picker.applyKey(Buffer.from(KEYS.esc));

  const shown = ctx.terminal.getTextSince(mark);

  expect(shown).toInclude('spawn: workspace');
  expect(shown).toInclude('\u001B[7mgithub:acme-tools/widgets');
  expect(ctx.daemon.collectSent('git.probe')).toStrictEqual([]);
});

test('it reads typed github:owner/repo text that no listing holds through the source and probes it', async () => {
  const ctx = setupTest();

  const picker = createSpawnPicker({
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
      { id: 'dirs', label: 'directory on the daemon host', kind: 'path' },
      { id: 'github', label: 'GitHub repository', kind: 'git' },
    ],
  });

  await ctx.daemon.answerOldest('sources.list', { candidates: [] });

  await ctx.daemon.answer('sources.list', {
    candidates: [
      {
        label: 'acme-tools/widgets',
        pick: { kind: 'git', url: 'git@github.com:acme-tools/widgets.git' },
      },
    ],
  });

  picker.applyKey(Buffer.from(`github:acme-tools/unlisted${KEYS.enter}`));

  await ctx.daemon.answer('sources.interpret', {
    kind: 'git',
    url: 'git@github.com:acme-tools/unlisted.git',
  });

  expect(ctx.daemon.collectSent('sources.interpret')).toStrictEqual([
    { source: 'github', input: 'github:acme-tools/unlisted', target: 'local' },
  ]);

  expect(ctx.daemon.collectSent('git.probe')).toStrictEqual([
    { url: 'git@github.com:acme-tools/unlisted.git', target: 'local' },
  ]);
});

test('it probes the typed repository, not a listed one whose name it starts', async () => {
  const ctx = setupTest();

  const picker = createSpawnPicker({
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
    sources: [{ id: 'github', label: 'GitHub repository', kind: 'git' }],
  });

  await ctx.daemon.answer('sources.list', {
    candidates: [
      {
        label: 'harbor-labs/widget-tools',
        pick: { kind: 'git', url: 'git@github.com:harbor-labs/widget-tools.git' },
      },
    ],
  });

  picker.applyKey(Buffer.from(`github:harbor-labs/widget${KEYS.enter}`));

  await ctx.daemon.answer('sources.interpret', {
    kind: 'git',
    url: 'git@github.com:harbor-labs/widget.git',
  });

  expect(ctx.daemon.collectSent('git.probe')).toStrictEqual([
    { url: 'git@github.com:harbor-labs/widget.git', target: 'local' },
  ]);
});

test('it refuses a typed git URL that no source reads when the daemon offers only directories', async () => {
  const ctx = setupTest();

  const picker = createSpawnPicker({
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

  await ctx.daemon.answer('sources.list', { candidates: [] });

  picker.applyKey(Buffer.from(`https://example.com/acme/tool.git${KEYS.enter}`));

  const mark = ctx.terminal.countChunks();

  await ctx.daemon.answer('sources.interpret', { kind: 'none' });

  expect(ctx.terminal.getTextSince(mark)).toInclude(
    'no source reads https://example.com/acme/tool.git · esc back',
  );

  expect(ctx.daemon.collectSent('git.probe')).toStrictEqual([]);
});

test('it shows the rows of two git sources that list at once when both answer', async () => {
  const ctx = setupTest();

  const picker = createSpawnPicker({
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
      { id: 'gitlab', label: 'GitLab repository', kind: 'git' },
      { id: 'github', label: 'GitHub repository', kind: 'git' },
    ],
  });

  await ctx.daemon.answerOldest('sources.list', {
    candidates: [
      {
        label: 'harbor-labs/beacon',
        pick: { kind: 'git', url: 'git@gitlab.com:harbor-labs/beacon.git' },
      },
    ],
  });

  const mark = ctx.terminal.countChunks();

  await ctx.daemon.answer('sources.list', {
    candidates: [
      {
        label: 'acme-tools/gadgets',
        pick: { kind: 'git', url: 'git@github.com:acme-tools/gadgets.git' },
      },
    ],
  });

  const shown = ctx.terminal.getTextSince(mark);

  expect(ctx.dropped).toStrictEqual([]);
  expect(shown).toInclude('gitlab:harbor-labs/beacon');
  expect(shown).toInclude('github:acme-tools/gadgets');
});

test('it keeps the selected row selected when another source listing lands', async () => {
  const ctx = setupTest();

  const picker = createSpawnPicker({
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
      { id: 'dirs', label: 'directory on the daemon host', kind: 'path' },
      { id: 'github', label: 'GitHub repository', kind: 'git' },
    ],
  });

  await ctx.daemon.answer('sources.list', {
    candidates: [
      {
        label: 'acme-tools/gadgets',
        pick: { kind: 'git', url: 'git@github.com:acme-tools/gadgets.git' },
      },
      {
        label: 'acme-tools/widgets',
        pick: { kind: 'git', url: 'git@github.com:acme-tools/widgets.git' },
      },
    ],
  });

  picker.applyKey(Buffer.from(KEYS.tab));
  picker.applyKey(Buffer.from(KEYS.down));

  const mark = ctx.terminal.countChunks();

  await ctx.daemon.answerOldest('sources.list', {
    candidates: [
      { label: '~/code/lamp', pick: { kind: 'path', directory: '/srv/code/lamp' } },
      { label: '~/code/kettle', pick: { kind: 'path', directory: '/srv/code/kettle' } },
    ],
  });

  expect(ctx.terminal.getTextSince(mark)).toInclude('\u001B[7mgithub:acme-tools/widgets');
});

test('it lists every git source again on ctrl-r and leaves the directories alone', async () => {
  const ctx = setupTest();

  const picker = createSpawnPicker({
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
      { id: 'dirs', label: 'directory on the daemon host', kind: 'path' },
      { id: 'gitlab', label: 'GitLab repository', kind: 'git' },
      { id: 'github', label: 'GitHub repository', kind: 'git' },
    ],
  });

  picker.applyKey(Buffer.from(KEYS.ctrlR));

  expect(ctx.daemon.collectSent('sources.list')).toStrictEqual([
    { source: 'dirs' },
    { source: 'gitlab', target: 'local' },
    { source: 'github', target: 'local' },
    { source: 'gitlab', target: 'local' },
    { source: 'github', target: 'local' },
  ]);
});

test('it reads a typed path through the directory source before the git sources', async () => {
  const ctx = setupTest();

  const picker = createSpawnPicker({
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
      { id: 'git', label: 'git URL', kind: 'git' },
      { id: 'dirs', label: 'directory on the daemon host', kind: 'path' },
    ],
  });

  picker.applyKey(Buffer.from(`/srv/orchard/ledger.git${KEYS.enter}`));

  const mark = ctx.terminal.countChunks();

  await ctx.daemon.answer('sources.interpret', {
    kind: 'path',
    directory: '/srv/orchard/ledger.git',
  });

  expect(ctx.daemon.collectSent('sources.interpret')).toStrictEqual([
    { source: 'dirs', input: '/srv/orchard/ledger.git', clientCwd: ctx.cwd },
  ]);

  expect(ctx.terminal.getTextSince(mark)).toInclude('spawn: name');
  expect(ctx.daemon.collectSent('git.probe')).toStrictEqual([]);
});

test('it fits every key of a list with a git source in the hint row, esc back included', async () => {
  const ctx = setupTest();

  const picker = createSpawnPicker({
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
    sources: [
      { id: 'dirs', label: 'directory on the daemon host', kind: 'path' },
      { id: 'github', label: 'GitHub repository', kind: 'git' },
    ],
  });

  expect(ctx.terminal.getTextSince(mark)).toInclude(
    'type to filter · ⏎ select · ^r refresh · tab next source · esc back',
  );
});

test('it opens at the daemon step when a remote daemon is up beside the primary', () => {
  const ctx = setupTest();

  const picker = createSpawnPicker({
    ...ctx.deps,
    upDaemons: () => [null, 'box'],
    ptyRows: () => 24,
    getLastUsedAgent: () => 'claude',
  });

  const mark = ctx.terminal.countChunks();

  picker.open();

  const shown = ctx.terminal.getTextSince(mark);

  expect(shown).toInclude('spawn: daemon');
  expect(shown).toInclude('local');
  expect(shown).toInclude('box');
  expect(ctx.daemon.collectSent('agents.list')).toStrictEqual([]);
});

test('it opens at the daemon step when the one daemon up is not the primary', () => {
  const ctx = setupTest();

  const picker = createSpawnPicker({
    ...ctx.deps,
    upDaemons: () => ['box'],
    ptyRows: () => 24,
    getLastUsedAgent: () => 'claude',
  });

  const mark = ctx.terminal.countChunks();

  picker.open();

  expect(ctx.terminal.getTextSince(mark)).toInclude('spawn: daemon');
});

test('it reads the agents of the picked daemon, starting on that daemon last used agent', async () => {
  const ctx = setupTest();
  const sentTo: DaemonName[] = [];

  const picker = createSpawnPicker({
    ...ctx.deps,
    upDaemons: () => [null, 'box'],
    sendRequest: (
      daemon: DaemonName,
      method: string,
      params?: Readonly<Record<string, unknown>>,
    ) => {
      sentTo.push(daemon);

      return ctx.daemon.sendRequest(method, params);
    },
    ptyRows: () => 24,
    getLastUsedAgent: (daemon: DaemonName) => (daemon === 'box' ? 'grok' : 'claude'),
  });

  picker.open();
  picker.applyKey(Buffer.from(KEYS.down));
  picker.applyKey(Buffer.from(KEYS.enter));

  const mark = ctx.terminal.countChunks();

  await ctx.daemon.answer('agents.list', {
    agents: [
      buildMockListedAgent({
        id: 'claude',
        label: 'Claude',
        installed: true,
        capabilities: { spawn: true },
      }),
      buildMockListedAgent({
        id: 'grok',
        label: 'Grok',
        installed: true,
        capabilities: { spawn: true },
      }),
    ],
    targets: [],
    sources: [{ id: 'dirs', label: 'directory on the daemon host', kind: 'path' }],
  });

  expect(sentTo).toStrictEqual(['box']);
  expect(ctx.terminal.getTextSince(mark)).toInclude('\u001B[7mGrok');
});

test('it lists the picked remote daemon directories without the client directory, and spawns and attaches there', async () => {
  const ctx = setupTest();
  const attached: [DaemonName, string][] = [];

  const picker = createSpawnPicker({
    ...ctx.deps,
    upDaemons: () => [null, 'box'],
    attach: (daemon: DaemonName, id: string) => {
      attached.push([daemon, id]);

      return ctx.deps.attach();
    },
    ptyRows: () => 24,
    getLastUsedAgent: () => 'claude',
  });

  picker.open();
  picker.applyKey(Buffer.from(KEYS.down));
  picker.applyKey(Buffer.from(KEYS.enter));

  await ctx.daemon.answer('agents.list', {
    agents: [
      buildMockListedAgent({ id: 'claude', installed: true, capabilities: { spawn: true } }),
    ],
    targets: [],
    sources: [{ id: 'dirs', label: 'directory on the daemon host', kind: 'path' }],
  });

  expect(ctx.daemon.collectSent('sources.list')).toStrictEqual([{ source: 'dirs' }]);

  await ctx.daemon.answer('sources.list', {
    source: 'dirs',
    scope: null,
    candidates: [{ label: '/srv/orchard', pick: { kind: 'path', directory: '/srv/orchard' } }],
  });

  picker.applyKey(Buffer.from(KEYS.enter));
  picker.applyKey(Buffer.from(`far-one${KEYS.enter}`));
  picker.applyKey(Buffer.from(KEYS.enter));

  expect(ctx.daemon.collectSent('session.spawn')[0]).not.toHaveProperty('clientCwd');

  await ctx.daemon.answer('session.spawn', {
    session: buildMockSessionDescriptor({ id: toSessionID('on-the-box') }),
  });

  expect(attached).toStrictEqual([['box', 'on-the-box']]);
});

test('it goes back to the daemon step on esc from the agent step', async () => {
  const ctx = setupTest();

  const picker = createSpawnPicker({
    ...ctx.deps,
    upDaemons: () => [null, 'box'],
    ptyRows: () => 24,
    getLastUsedAgent: () => 'claude',
  });

  picker.open();
  picker.applyKey(Buffer.from(KEYS.enter));

  await ctx.daemon.answer('agents.list', {
    agents: [
      buildMockListedAgent({ id: 'claude', installed: true, capabilities: { spawn: true } }),
      buildMockListedAgent({ id: 'grok', installed: true, capabilities: { spawn: true } }),
    ],
    targets: [],
    sources: [{ id: 'dirs', label: 'directory on the daemon host', kind: 'path' }],
  });

  const mark = ctx.terminal.countChunks();

  picker.applyKey(Buffer.from(KEYS.esc));

  expect(ctx.terminal.getTextSince(mark)).toInclude('spawn: daemon');
  expect(ctx.counts.exits).toBe(0);
});

test('it reports the picker open on a daemon only past the daemon step', () => {
  const ctx = setupTest();

  const picker = createSpawnPicker({
    ...ctx.deps,
    upDaemons: () => [null, 'box'],
    ptyRows: () => 24,
    getLastUsedAgent: () => 'claude',
  });

  expect(picker.isOpenOn('box')).toBe(false);

  picker.open();

  expect(picker.isOpenOn(null)).toBe(false);

  picker.applyKey(Buffer.from(KEYS.down));
  picker.applyKey(Buffer.from(KEYS.enter));

  expect(picker.isOpenOn('box')).toBe(true);
  expect(picker.isOpenOn(null)).toBe(false);
});
