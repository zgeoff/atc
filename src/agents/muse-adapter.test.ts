import { Database } from 'bun:sqlite';
import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../shared/config';
import { toAgentSessionID } from '../shared/to-agent-session-id';
import { toSessionID } from '../shared/to-session-id';
import { MuseAdapter } from './muse-adapter';

function buildMuseConfig(): Config {
  return {
    claudeBin: 'claude',
    claudeArgs: [],
    grokBin: 'grok',
    grokArgs: [],
    codexBin: 'codex',
    codexArgs: [],
    museBin: 'muse',
    museArgs: [],
    dirs: { roots: [] },
    gateways: [],
    hooks: {},
    leader: { code: 0, label: '^Space' },
  };
}

interface IndexedSession {
  readonly sessionID: string;
  readonly title: string;
  readonly sessionName: string;
}

// Only the columns the adapter reads: Muse's real table carries thirty more,
// and depending on them here would tie the test to its schema version.
function setupMuseDataHome(sessions: readonly IndexedSession[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'atc-muse-'));
  const prev = process.env['XDG_DATA_HOME'];

  process.env['XDG_DATA_HOME'] = dir;

  mkdirSync(join(dir, 'muse'), { recursive: true });

  const db = new Database(join(dir, 'muse', 'session-index.db'), { create: true });

  db.run('CREATE TABLE sessions (session_id TEXT PRIMARY KEY, title TEXT, session_name TEXT)');

  for (const s of sessions) {
    db.run('INSERT INTO sessions VALUES (?, ?, ?)', [s.sessionID, s.title, s.sessionName]);
  }

  db.close();

  onTestFinished(() => {
    if (prev === undefined) {
      delete process.env['XDG_DATA_HOME'];
    } else {
      process.env['XDG_DATA_HOME'] = prev;
    }

    rmSync(dir, { recursive: true, force: true });
  });

  return dir;
}

test('it spawns fresh, picker-resume, and id-resume muse commands', () => {
  const adapter = new MuseAdapter(buildMuseConfig());

  expect(adapter.planSpawn({ prompt: 'fix the bug', resume: false })).toStrictEqual({
    bin: 'muse',
    args: ['fix the bug'],
  });

  expect(adapter.planSpawn({ prompt: '', resume: true })).toStrictEqual({
    bin: 'muse',
    args: ['resume'],
  });

  expect(adapter.planSpawn({ prompt: '', resume: toAgentSessionID('m-1') })).toStrictEqual({
    bin: 'muse',
    args: ['resume', 'm-1'],
  });
});

test('it maps a muse session start to started with a name source but no transcript source', () => {
  const adapter = new MuseAdapter(buildMuseConfig());

  const ev = adapter.normalizeHook({
    atcId: toSessionID('s1'),
    event: 'SessionStart',

    // Muse reports transcript_path as null on every event it emits.
    payload: {
      session_id: 'm-1',
      transcript_path: null,
      cwd: '/tmp',
      hook_event_name: 'SessionStart',
      source: 'startup',
    },
  });

  expect(ev).toStrictEqual({
    kind: 'started',
    agentSessionID: toAgentSessionID('m-1'),
    nameSource: 'm-1',
  });
});

test('it maps muse prompt, stop, permission, notification, and end events to session kinds', () => {
  const adapter = new MuseAdapter(buildMuseConfig());

  const submitted = adapter.normalizeHook({
    atcId: toSessionID('s1'),
    event: 'UserPromptSubmit',
    payload: { session_id: 'm-1', prompt: 'do the thing' },
  });

  expect(submitted).toMatchObject({ kind: 'prompt-submitted', message: 'do the thing' });

  const stopped = adapter.normalizeHook({
    atcId: toSessionID('s1'),
    event: 'Stop',
    payload: { session_id: 'm-1', last_assistant_message: 'pong' },
  });

  expect(stopped).toMatchObject({ kind: 'turn-done', detail: 'pong' });

  const approval = adapter.normalizeHook({
    atcId: toSessionID('s1'),
    event: 'PermissionRequest',
    payload: { session_id: 'm-1', tool_name: 'shell' },
  });

  expect(approval).toMatchObject({ kind: 'needs-input', message: 'waiting for approval: shell' });

  const notified = adapter.normalizeHook({
    atcId: toSessionID('s1'),
    event: 'Notification',
    payload: { session_id: 'm-1', message: 'needs your attention' },
  });

  expect(notified).toMatchObject({ kind: 'needs-input', message: 'needs your attention' });

  const ended = adapter.normalizeHook({
    atcId: toSessionID('s1'),
    event: 'SessionEnd',
    payload: { session_id: 'm-1', reason: 'other' },
  });

  expect(ended).toStrictEqual({ kind: 'ended', agentSessionID: toAgentSessionID('m-1') });
});

test('it prefers the indexed title, falls back to the handle, and never overrides a user name', async () => {
  setupMuseDataHome([
    { sessionID: 'm-1', title: 'hook probe', sessionName: 'vivid-redshift' },
    { sessionID: 'm-2', title: 'New session', sessionName: 'mineral-cosmos' },
    { sessionID: 'm-3', title: 'New session', sessionName: '' },
  ]);

  const adapter = new MuseAdapter(buildMuseConfig());

  const titled = await adapter.loadName('m-1', 'auto');
  const handled = await adapter.loadName('m-2', 'auto');
  const nameless = await adapter.loadName('m-3', 'auto');
  const userNamed = await adapter.loadName('m-1', 'user');
  const missing = await adapter.loadName('m-missing', 'auto');

  expect(titled).toStrictEqual({ name: 'hook probe' });
  expect(handled).toStrictEqual({ name: 'mineral-cosmos' });
  expect(nameless).toBeNull();
  expect(userNamed).toBeNull();
  expect(missing).toBeNull();
});

test('it reads no name rather than throwing when the session index is absent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'atc-muse-empty-'));
  const prev = process.env['XDG_DATA_HOME'];

  process.env['XDG_DATA_HOME'] = dir;

  onTestFinished(() => {
    if (prev === undefined) {
      delete process.env['XDG_DATA_HOME'];
    } else {
      process.env['XDG_DATA_HOME'] = prev;
    }

    rmSync(dir, { recursive: true, force: true });
  });

  const adapter = new MuseAdapter(buildMuseConfig());

  const name = await adapter.loadName('m-1', 'auto');

  expect(name).toBeNull();
});

test('it resumes only a session whose agent id was captured', () => {
  const adapter = new MuseAdapter(buildMuseConfig());

  expect(adapter.canResume({ agentSessionID: toAgentSessionID('m-1') })).toBe(true);
  expect(adapter.canResume({})).toBe(false);
});

test('it maps a non-object hook payload to a bare heartbeat instead of throwing', () => {
  const adapter = new MuseAdapter(buildMuseConfig());

  const ev = adapter.normalizeHook({
    atcId: toSessionID('s1'),
    event: 'Stop',

    // oxlint-disable-next-line no-unsafe-type-assertion -- exercising a payload shape the HookEvent type rules out but a hostile or buggy reporter could still send
    payload: 'garbage' as unknown as Record<string, unknown>,
  });

  expect(ev).toStrictEqual({ kind: 'turn-done' });
});

test('it treats wrong-typed hook payload fields as absent instead of throwing', () => {
  const adapter = new MuseAdapter(buildMuseConfig());

  const ev = adapter.normalizeHook({
    atcId: toSessionID('s1'),
    event: 'PermissionRequest',
    payload: { session_id: null, tool_name: 7 },
  });

  expect(ev).toStrictEqual({
    kind: 'needs-input',
    message: 'waiting for approval',
    detail: 'waiting for approval',
  });
});

test('it builds muse resume commands with and without a captured id', () => {
  const adapter = new MuseAdapter(buildMuseConfig());

  expect(adapter.buildResumeCommand("/tmp/it's", toAgentSessionID('m-1'))).toBe(
    String.raw`cd '/tmp/it'\''s' && muse resume m-1`,
  );

  expect(adapter.buildResumeCommand('/tmp', undefined)).toBe(`cd '/tmp' && muse resume`);
});
