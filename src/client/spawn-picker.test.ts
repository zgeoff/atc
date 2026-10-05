import { expect, onTestFinished, spyOn, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { configFile } from '../shared/config';
import { SpawnPicker } from './spawn-picker';

interface SentRequest {
  readonly m: string;
  readonly p: Readonly<Record<string, unknown>>;
  readonly resolve: (answer: Readonly<Record<string, unknown>>) => void;
}

const LOCAL = {
  id: 'local',
  provider: 'local-pty',
  available: true,
  default: true,
  capabilities: { transfer: true, run: true },
};

const BOX = {
  id: 'box',
  provider: 'imp',
  available: true,
  default: false,
  capabilities: { transfer: true, run: true },
};

const DIR_SOURCE = { id: 'dirs', label: 'directory on the daemon host', kind: 'path' };
const GIT_SOURCE = { id: 'fake', label: 'fake repository', kind: 'git' };
const ENTER = Buffer.from('\r');
const ESC = Buffer.from('\u001B');
const DOWN = Buffer.from('\u001B[B');
const LEADER = Buffer.from([0x1d]);

/**
 * A spawn picker whose daemon answers only when a test says so. Every
 * request it sends waits in `sent` until the test resolves it, the screen
 * writes collect in `screen`, and each draw counts in `renders`. The config holds
 * Claude, at the running Bun, as the one installed agent, whatever the host
 * machine has on its PATH.
 */
function setupTest() {
  mkdirSync(dirname(configFile), { recursive: true });

  writeFileSync(
    configFile,
    JSON.stringify({ claudeBin: process.execPath, grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  const screen: string[] = [];

  const write = spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    screen.push(String(chunk));

    return true;
  });

  onTestFinished(() => {
    write.mockRestore();

    rmSync(configFile, { force: true });
  });

  const sent: SentRequest[] = [];
  const counts = { renders: 0, exits: 0, attached: 0 };

  const picker = new SpawnPicker<{ readonly id: string }>({
    sendRequest: (m, p = {}) =>
      new Promise((resolve) => {
        sent.push({ m, p, resolve });
      }),
    ptyRows: () => 24,
    isLeaderKey: (buf) => buf.length === 1 && buf[0] === 0x1d,
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
    toMirrorSession: (value) => (value === null ? null : { id: 's-1' }),
    upsertMirror: () => {},
  });

  // Answers the last request sent under a method, then lets the picker
  // act on the answer.
  const answer = async (m: string, value: Readonly<Record<string, unknown>>) => {
    const request = sent.findLast((r) => r.m === m);

    if (request === undefined) {
      throw new Error(`no ${m} request was sent`);
    }

    request.resolve(value);

    await Bun.sleep(10);
  };

  const applyKeys = async (...keys: readonly Buffer[]) => {
    for (const key of keys) {
      picker.applyKey(key);

      await Bun.sleep(10);
    }
  };

  const collectSent = (m: string) => sent.filter((r) => r.m === m).map((r) => r.p);

  return { picker, sent, screen, counts, answer, applyKeys, collectSent };
}

test('it drops the target and source answer that arrives after esc leaves the agent step', async () => {
  const ctx = setupTest();

  writeFileSync(
    configFile,
    JSON.stringify({
      claudeBin: process.execPath,
      grokBin: process.execPath,
      codexBin: 'no-codex',
    }),
  );

  ctx.picker.open();

  await ctx.applyKeys(ENTER, ESC);

  const renders = ctx.counts.renders;

  await ctx.answer('agents.list', { targets: [LOCAL], sources: [GIT_SOURCE] });

  expect(ctx.counts.exits).toBe(1);
  expect(ctx.counts.renders).toBe(renders);
  expect(ctx.collectSent('sources.list')).toStrictEqual([]);
});

test('it drops the directory history that arrives after esc leaves a daemon without sources', async () => {
  const ctx = setupTest();

  ctx.picker.open();

  await ctx.answer('agents.list', { targets: [LOCAL] });
  await ctx.applyKeys(ESC);

  const renders = ctx.counts.renders;

  await ctx.answer('dirs.list', { dirs: ['/srv/one'] });

  expect(ctx.counts.exits).toBe(1);
  expect(ctx.counts.renders).toBe(renders);
});

test('it drops a git listing that arrives after the leader leaves the flow', async () => {
  const ctx = setupTest();

  ctx.picker.open();

  await ctx.answer('agents.list', { targets: [LOCAL], sources: [GIT_SOURCE] });
  await ctx.applyKeys(LEADER);

  const renders = ctx.counts.renders;

  await ctx.answer('sources.list', {
    source: 'fake',
    scope: null,
    candidates: [{ label: 'app', pick: { kind: 'git', url: 'https://example.com/app.git' } }],
  });

  expect(ctx.counts.exits).toBe(1);
  expect(ctx.counts.renders).toBe(renders);
});

test('it drops a directory listing that arrives after the leader leaves the flow', async () => {
  const ctx = setupTest();

  ctx.picker.open();

  await ctx.answer('agents.list', { targets: [LOCAL], sources: [DIR_SOURCE] });
  await ctx.applyKeys(LEADER);

  const renders = ctx.counts.renders;

  await ctx.answer('sources.list', {
    source: 'dirs',
    scope: null,
    candidates: [{ label: '/srv/one', pick: { kind: 'path', dir: '/srv/one' } }],
  });

  expect(ctx.counts.exits).toBe(1);
  expect(ctx.counts.renders).toBe(renders);
});

test('it drops a reading that arrives after the leader leaves the flow', async () => {
  const ctx = setupTest();

  ctx.picker.open();

  await ctx.answer('agents.list', { targets: [LOCAL], sources: [GIT_SOURCE] });
  await ctx.answer('sources.list', { source: 'fake', scope: null, candidates: [] });
  await ctx.applyKeys(Buffer.from('acme/'), ENTER, LEADER);

  const renders = ctx.counts.renders;

  await ctx.answer('sources.interpret', { kind: 'browse', scope: 'acme' });

  expect(ctx.counts.exits).toBe(1);
  expect(ctx.counts.renders).toBe(renders);
  expect(ctx.collectSent('sources.list')).toHaveLength(1);
});

test('it drops a probe answer that arrives after esc cancels it and the leader leaves', async () => {
  const ctx = setupTest();

  ctx.picker.open();

  await ctx.answer('agents.list', { targets: [LOCAL], sources: [GIT_SOURCE] });
  await ctx.answer('sources.list', { source: 'fake', scope: null, candidates: [] });
  await ctx.applyKeys(Buffer.from('https://example.com/app.git'), ENTER, ESC, LEADER);

  const renders = ctx.counts.renders;

  await ctx.answer('git.probe', {
    url: 'https://example.com/app.git',
    head: 'main',
    refs: [{ name: 'main', kind: 'branch', sha: 'a'.repeat(40) }],
    resolved: null,
  });

  expect(ctx.counts.exits).toBe(1);
  expect(ctx.counts.renders).toBe(renders);
});

test('it neither attaches nor draws a spawn that answers after esc stops waiting on it', async () => {
  const ctx = setupTest();

  ctx.picker.open();

  await ctx.answer('agents.list', { targets: [LOCAL], sources: [DIR_SOURCE] });
  await ctx.answer('sources.list', { source: 'dirs', scope: null, candidates: [] });
  await ctx.applyKeys(ENTER, ENTER, ENTER, ESC);

  const renders = ctx.counts.renders;

  await ctx.answer('session.spawn', { session: { id: 's-1' } });

  expect(ctx.counts.exits).toBe(1);
  expect(ctx.counts.renders).toBe(renders);
  expect(ctx.counts.attached).toBe(0);
});

test('it materializes a directory on the one target when that target is remote', async () => {
  const ctx = setupTest();

  ctx.picker.open();

  await ctx.answer('agents.list', { targets: [BOX], sources: [DIR_SOURCE] });
  await ctx.answer('sources.list', { source: 'dirs', scope: null, candidates: [] });
  await ctx.applyKeys(ENTER, ENTER, ENTER);

  expect(ctx.collectSent('session.spawn')).toMatchObject([
    { cwd: process.cwd(), target: 'box', workspace: { kind: 'path', path: process.cwd() } },
  ]);
});

test('it holds a session whose workspace left changes behind until enter attaches it', async () => {
  const ctx = setupTest();

  ctx.picker.open();

  await ctx.answer('agents.list', { targets: [BOX], sources: [DIR_SOURCE] });
  await ctx.answer('sources.list', { source: 'dirs', scope: null, candidates: [] });
  await ctx.applyKeys(ENTER, ENTER, ENTER);

  await ctx.answer('session.spawn', {
    session: { id: 's-1' },
    warnings: [
      'cloned commit 0123456789ab; left 2 uncommitted or untracked paths behind in /src/app',
    ],
  });

  const held = ctx.counts.attached;

  await ctx.applyKeys(ENTER);

  expect(held).toBe(0);
  expect(ctx.counts.attached).toBe(1);
  expect(ctx.counts.exits).toBe(0);
});

test('it shows the whole note of a workspace that left changes behind, wrapped to the picker', async () => {
  const ctx = setupTest();

  ctx.picker.open();

  await ctx.answer('agents.list', { targets: [BOX], sources: [DIR_SOURCE] });
  await ctx.answer('sources.list', { source: 'dirs', scope: null, candidates: [] });
  await ctx.applyKeys(ENTER, ENTER, ENTER);

  ctx.screen.length = 0;

  await ctx.answer('session.spawn', {
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
  const ctx = setupTest();

  ctx.picker.open();

  await ctx.answer('agents.list', { targets: [BOX], sources: [DIR_SOURCE] });
  await ctx.answer('sources.list', { source: 'dirs', scope: null, candidates: [] });
  await ctx.applyKeys(ENTER, ENTER, ENTER);

  await ctx.answer('session.spawn', {
    session: { id: 's-1' },
    warnings: [
      'cloned commit 0123456789ab; left 1 uncommitted or untracked path behind in /src/app',
    ],
  });

  await ctx.applyKeys(ESC);

  expect(ctx.counts.attached).toBe(0);
  expect(ctx.counts.exits).toBe(1);
  expect(ctx.collectSent('session.spawn')).toHaveLength(1);
});

test('it attaches a session spawned without warnings at once', async () => {
  const ctx = setupTest();

  ctx.picker.open();

  await ctx.answer('agents.list', { targets: [BOX], sources: [DIR_SOURCE] });
  await ctx.answer('sources.list', { source: 'dirs', scope: null, candidates: [] });
  await ctx.applyKeys(ENTER, ENTER, ENTER);
  await ctx.answer('session.spawn', { session: { id: 's-1' } });

  expect(ctx.counts.attached).toBe(1);
});

test('it runs a directory in place on the one target when that target is local', async () => {
  const ctx = setupTest();

  ctx.picker.open();

  await ctx.answer('agents.list', { targets: [LOCAL], sources: [DIR_SOURCE] });
  await ctx.answer('sources.list', { source: 'dirs', scope: null, candidates: [] });
  await ctx.applyKeys(ENTER, ENTER, ENTER);

  const [spawned] = ctx.collectSent('session.spawn');

  expect(spawned).toMatchObject({ cwd: process.cwd() });
  expect(spawned?.['workspace']).toBeUndefined();
});

test('it adopts in place on the one local target it offers', async () => {
  const ctx = setupTest();

  ctx.picker.open(true);

  await ctx.answer('agents.list', { targets: [BOX, LOCAL], sources: [DIR_SOURCE] });
  await ctx.answer('sources.list', { source: 'dirs', scope: null, candidates: [] });
  await ctx.applyKeys(ENTER, ENTER);

  const [spawned] = ctx.collectSent('session.spawn');

  expect(spawned).toMatchObject({ cwd: process.cwd(), resume: true, target: 'local' });
  expect(spawned?.['workspace']).toBeUndefined();
});

test('it offers an agent that takes the broker credential only the targets that reach the broker', async () => {
  const ctx = setupTest();

  ctx.picker.open();

  await ctx.answer('agents.list', {
    agents: [{ id: 'claude', brokerAuth: true }],
    targets: [LOCAL, { ...BOX, brokerAuth: true }],
    sources: [DIR_SOURCE],
  });

  await ctx.answer('sources.list', { source: 'dirs', scope: null, candidates: [] });
  await ctx.applyKeys(ENTER, ENTER, ENTER);

  expect(ctx.collectSent('session.spawn')).toMatchObject([{ target: 'box' }]);
});

test('it offers an agent that takes no broker credential every target', async () => {
  const ctx = setupTest();

  ctx.picker.open();

  await ctx.answer('agents.list', {
    agents: [{ id: 'claude', brokerAuth: false }],
    targets: [LOCAL, { ...BOX, brokerAuth: true }],
    sources: [DIR_SOURCE],
  });

  await ctx.answer('sources.list', { source: 'dirs', scope: null, candidates: [] });
  await ctx.applyKeys(ENTER, ENTER, ENTER, ENTER);

  expect(ctx.collectSent('session.spawn')).toMatchObject([{ target: 'local' }]);
});

test('it lists a scope read from typed text once, on the target chosen after it', async () => {
  const ctx = setupTest();

  ctx.picker.open();

  await ctx.answer('agents.list', { targets: [LOCAL, BOX], sources: [DIR_SOURCE, GIT_SOURCE] });
  await ctx.answer('sources.list', { source: 'dirs', scope: null, candidates: [] });
  await ctx.applyKeys(Buffer.from('acme/'), ENTER);
  await ctx.answer('sources.interpret', { kind: 'none' });
  await ctx.answer('sources.interpret', { kind: 'browse', scope: 'acme' });
  await ctx.applyKeys(DOWN, ENTER);

  expect(ctx.collectSent('sources.list').filter((p) => p['source'] === 'fake')).toStrictEqual([
    { source: 'fake', scope: 'acme', target: 'box' },
  ]);
});

test('it starts a new flow on the default target, not the one the last flow chose', async () => {
  const ctx = setupTest();

  ctx.picker.open();

  await ctx.answer('agents.list', { targets: [LOCAL, BOX], sources: [DIR_SOURCE] });
  await ctx.answer('sources.list', { source: 'dirs', scope: null, candidates: [] });
  await ctx.applyKeys(ENTER, DOWN, ENTER, ENTER, ENTER);
  await ctx.answer('session.spawn', { session: { id: 's-1' } });

  ctx.picker.open();

  await ctx.answer('agents.list', { targets: [LOCAL, BOX], sources: [DIR_SOURCE] });
  await ctx.answer('sources.list', { source: 'dirs', scope: null, candidates: [] });
  await ctx.applyKeys(ENTER, ENTER, ENTER, ENTER);

  expect(ctx.collectSent('session.spawn').map((p) => p['target'])).toStrictEqual(['box', 'local']);
});

test('it lists a git source again when the flow left it before its listing answered', async () => {
  const ctx = setupTest();
  const tab = Buffer.from('\t');

  ctx.picker.open();

  await ctx.answer('agents.list', { targets: [LOCAL], sources: [GIT_SOURCE, DIR_SOURCE] });
  await ctx.applyKeys(tab);
  await ctx.answer('sources.list', { source: 'dirs', scope: null, candidates: [] });
  await ctx.applyKeys(tab);

  expect(ctx.collectSent('sources.list').filter((p) => p['source'] === 'fake')).toHaveLength(2);
});

test('it reads the targets and sources at once when one agent is installed', () => {
  const ctx = setupTest();

  ctx.picker.open();

  expect(ctx.collectSent('agents.list')).toStrictEqual([{}]);
});

test('it waits on the agent choice when more than one agent is installed', () => {
  const ctx = setupTest();

  writeFileSync(
    configFile,
    JSON.stringify({
      claudeBin: process.execPath,
      grokBin: process.execPath,
      codexBin: 'no-codex',
    }),
  );

  ctx.picker.open();

  expect(ctx.collectSent('agents.list')).toStrictEqual([]);
});

test('it shows how to install an agent when none is installed', () => {
  const ctx = setupTest();

  writeFileSync(
    configFile,
    JSON.stringify({ claudeBin: 'no-claude', grokBin: 'no-grok', codexBin: 'no-codex' }),
  );

  ctx.picker.open();

  expect(ctx.screen.join('')).toInclude('no agent CLI found');
  expect(ctx.collectSent('agents.list')).toStrictEqual([]);
});

test('it reads the targets and sources once when enter repeats on the agent step', async () => {
  const ctx = setupTest();

  writeFileSync(
    configFile,
    JSON.stringify({
      claudeBin: process.execPath,
      grokBin: process.execPath,
      codexBin: 'no-codex',
    }),
  );

  ctx.picker.open();

  await ctx.applyKeys(ENTER, DOWN, ENTER);

  expect(ctx.collectSent('agents.list')).toHaveLength(1);
});

test('it returns esc from the directory step to the agent step when more than one agent is installed', async () => {
  const ctx = setupTest();

  writeFileSync(
    configFile,
    JSON.stringify({
      claudeBin: process.execPath,
      grokBin: process.execPath,
      codexBin: 'no-codex',
    }),
  );

  ctx.picker.open();

  await ctx.applyKeys(ENTER);
  await ctx.answer('agents.list', { targets: [LOCAL], sources: [DIR_SOURCE] });
  await ctx.answer('sources.list', { source: 'dirs', scope: null, candidates: [] });

  ctx.screen.length = 0;

  await ctx.applyKeys(ESC);

  expect(ctx.screen.join('')).toInclude('spawn: agent');
  expect(ctx.counts.exits).toBe(0);
});

test('it leaves the flow on esc from the directory step when one agent is installed', async () => {
  const ctx = setupTest();

  ctx.picker.open();

  await ctx.answer('agents.list', { targets: [LOCAL], sources: [DIR_SOURCE] });
  await ctx.answer('sources.list', { source: 'dirs', scope: null, candidates: [] });
  await ctx.applyKeys(ESC);

  expect(ctx.counts.exits).toBe(1);
});

test('it opens the name step after the directory when one agent and one target leave no choice', async () => {
  const ctx = setupTest();

  ctx.picker.open();

  await ctx.answer('agents.list', { targets: [LOCAL], sources: [DIR_SOURCE] });
  await ctx.answer('sources.list', { source: 'dirs', scope: null, candidates: [] });

  ctx.screen.length = 0;

  await ctx.applyKeys(ENTER);

  const shown = ctx.screen.join('');

  expect(shown).toInclude('spawn: name');
  expect(shown).not.toInclude('spawn: target');
});

test('it returns esc from the name step to the directory step when one target left no choice', async () => {
  const ctx = setupTest();

  ctx.picker.open();

  await ctx.answer('agents.list', { targets: [LOCAL], sources: [DIR_SOURCE] });
  await ctx.answer('sources.list', { source: 'dirs', scope: null, candidates: [] });
  await ctx.applyKeys(ENTER);

  ctx.screen.length = 0;

  await ctx.applyKeys(ESC);

  expect(ctx.screen.join('')).toInclude('spawn: directory on the daemon host');
  expect(ctx.counts.exits).toBe(0);
});

test('it lists a git source for the one target without a key when one agent and one target leave no choice', async () => {
  const ctx = setupTest();

  ctx.picker.open();

  await ctx.answer('agents.list', { targets: [LOCAL], sources: [GIT_SOURCE] });

  expect(ctx.collectSent('sources.list')).toStrictEqual([{ source: 'fake', target: 'local' }]);
});

test('it leaves the flow on esc from a git source when one agent and one target leave no choice', async () => {
  const ctx = setupTest();

  ctx.picker.open();

  await ctx.answer('agents.list', { targets: [LOCAL], sources: [GIT_SOURCE] });
  await ctx.answer('sources.list', { source: 'fake', scope: null, candidates: [] });
  await ctx.applyKeys(ESC);

  expect(ctx.counts.exits).toBe(1);
});

test('it takes the one available target for a directory when the other is unavailable', async () => {
  const ctx = setupTest();

  ctx.picker.open();

  await ctx.answer('agents.list', {
    targets: [LOCAL, { ...BOX, available: false }],
    sources: [DIR_SOURCE],
  });

  await ctx.answer('sources.list', { source: 'dirs', scope: null, candidates: [] });
  await ctx.applyKeys(ENTER, ENTER, ENTER);

  expect(ctx.collectSent('session.spawn')).toMatchObject([{ target: 'local' }]);
});

test('it takes the one target that takes a workspace for a repository', async () => {
  const ctx = setupTest();

  ctx.picker.open();

  await ctx.answer('agents.list', {
    targets: [{ ...LOCAL, capabilities: {} }, BOX],
    sources: [GIT_SOURCE],
  });

  expect(ctx.collectSent('sources.list')).toStrictEqual([{ source: 'fake', target: 'box' }]);
});

test('it offers both targets for a directory when only one takes a workspace', async () => {
  const ctx = setupTest();

  ctx.picker.open();

  await ctx.answer('agents.list', {
    targets: [{ ...LOCAL, capabilities: {} }, BOX],
    sources: [DIR_SOURCE],
  });

  await ctx.answer('sources.list', { source: 'dirs', scope: null, candidates: [] });

  ctx.screen.length = 0;

  await ctx.applyKeys(ENTER);

  expect(ctx.screen.join('')).toInclude('spawn: target');
});

test('it shows why no target can run a directory when the one target is unavailable', async () => {
  const ctx = setupTest();

  ctx.picker.open();

  await ctx.answer('agents.list', {
    targets: [{ ...BOX, available: false }],
    sources: [DIR_SOURCE],
  });

  await ctx.answer('sources.list', { source: 'dirs', scope: null, candidates: [] });

  ctx.screen.length = 0;

  await ctx.applyKeys(ENTER);

  const shown = ctx.screen.join('');

  expect(shown).toInclude('spawn: target');
  expect(shown).toInclude('none of these targets can run');
});

test('it shows why no target can run a repository when none takes a workspace', async () => {
  const ctx = setupTest();

  ctx.picker.open();

  await ctx.answer('agents.list', {
    targets: [{ ...LOCAL, capabilities: {} }],
    sources: [GIT_SOURCE],
  });

  expect(ctx.screen.join('')).toInclude('none of these targets can run the repository');
  expect(ctx.collectSent('sources.list')).toStrictEqual([]);
});

test('it shows why no target can run an agent whose broker no target reaches', async () => {
  const ctx = setupTest();

  ctx.picker.open();

  await ctx.answer('agents.list', {
    agents: [{ id: 'claude', brokerAuth: true }],
    targets: [LOCAL],
    sources: [DIR_SOURCE],
  });

  await ctx.answer('sources.list', { source: 'dirs', scope: null, candidates: [] });

  ctx.screen.length = 0;

  await ctx.applyKeys(ENTER);

  expect(ctx.screen.join('')).toInclude('no target reaches the credential broker claude needs');
  expect(ctx.collectSent('session.spawn')).toStrictEqual([]);
});

test('it shows why no target can adopt when none runs on the daemon host', async () => {
  const ctx = setupTest();

  ctx.picker.open(true);

  await ctx.answer('agents.list', { targets: [BOX], sources: [DIR_SOURCE] });
  await ctx.answer('sources.list', { source: 'dirs', scope: null, candidates: [] });

  ctx.screen.length = 0;

  await ctx.applyKeys(ENTER);

  expect(ctx.screen.join('')).toInclude('no target on this host can adopt a session');
  expect(ctx.collectSent('session.spawn')).toStrictEqual([]);
});

test('it returns esc from a target step with no usable target to the directory step', async () => {
  const ctx = setupTest();

  ctx.picker.open();

  await ctx.answer('agents.list', {
    targets: [{ ...BOX, available: false }],
    sources: [DIR_SOURCE],
  });

  await ctx.answer('sources.list', { source: 'dirs', scope: null, candidates: [] });
  await ctx.applyKeys(ENTER);

  ctx.screen.length = 0;

  await ctx.applyKeys(ESC);

  expect(ctx.screen.join('')).toInclude('spawn: directory on the daemon host');
  expect(ctx.counts.exits).toBe(0);
});

test('it drops the target and source answer of a flow that was left and opened again', async () => {
  const ctx = setupTest();

  ctx.picker.open();

  await ctx.applyKeys(ESC);

  ctx.picker.open();

  const renders = ctx.counts.renders;
  const [first] = ctx.sent;

  if (first === undefined) {
    throw new Error('no agents.list request was sent');
  }

  first.resolve({ targets: [LOCAL], sources: [DIR_SOURCE] });

  await Bun.sleep(10);

  expect(ctx.collectSent('agents.list')).toHaveLength(2);
  expect(ctx.collectSent('sources.list')).toStrictEqual([]);
  expect(ctx.counts.renders).toBe(renders);
});

test('it returns esc from a git source to the agent step when one target left no choice', async () => {
  const ctx = setupTest();

  writeFileSync(
    configFile,
    JSON.stringify({
      claudeBin: process.execPath,
      grokBin: process.execPath,
      codexBin: 'no-codex',
    }),
  );

  ctx.picker.open();

  await ctx.applyKeys(ENTER);
  await ctx.answer('agents.list', { targets: [LOCAL], sources: [GIT_SOURCE, DIR_SOURCE] });
  await ctx.answer('sources.list', { source: 'fake', scope: null, candidates: [] });

  ctx.screen.length = 0;

  await ctx.applyKeys(ESC);

  expect(ctx.screen.join('')).toInclude('spawn: agent');
  expect(ctx.counts.exits).toBe(0);
});
