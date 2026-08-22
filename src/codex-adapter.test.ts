import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentSessionID } from './agent-session-id';
import { CodexAdapter } from './codex-adapter';
import type { Config } from './config';
import type { SessionID } from './session-id';

function toSessionID(id: string): SessionID {
  // oxlint-disable-next-line no-unsafe-type-assertion -- test fixture literal stands in for a minted session id
  return id as SessionID;
}

function toAgentSessionID(id: string): AgentSessionID {
  // oxlint-disable-next-line no-unsafe-type-assertion -- test fixture literal stands in for an agent-minted session id
  return id as AgentSessionID;
}

function buildCodexConfig(): Config {
  return {
    claudeBin: 'claude',
    claudeArgs: [],
    grokBin: 'grok',
    grokArgs: [],
    codexBin: 'codex',
    codexArgs: [],
    gateways: [],
    leader: { code: 0, label: '^Space' },
  };
}

function setupCodexHome(indexLines: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'atc-codex-'));
  const prev = process.env['CODEX_HOME'];

  process.env['CODEX_HOME'] = dir;

  writeFileSync(join(dir, 'session_index.jsonl'), indexLines.join('\n'));

  onTestFinished(() => {
    if (prev === undefined) {
      delete process.env['CODEX_HOME'];
    } else {
      process.env['CODEX_HOME'] = prev;
    }

    rmSync(dir, { recursive: true, force: true });
  });

  return dir;
}

test('it spawns fresh, picker-resume, and id-resume codex commands', () => {
  const adapter = new CodexAdapter(buildCodexConfig());

  expect(adapter.planSpawn({ prompt: 'fix the bug', resume: false })).toStrictEqual({
    bin: 'codex',
    args: ['fix the bug'],
  });

  expect(adapter.planSpawn({ prompt: '', resume: true })).toStrictEqual({
    bin: 'codex',
    args: ['resume'],
  });

  expect(adapter.planSpawn({ prompt: '', resume: 'c-1' })).toStrictEqual({
    bin: 'codex',
    args: ['resume', 'c-1'],
  });
});

test('it maps a codex session start to started with id, name, and transcript sources', () => {
  const adapter = new CodexAdapter(buildCodexConfig());

  const ev = adapter.normalizeHook({
    atcId: toSessionID('s1'),
    event: 'SessionStart',
    payload: {
      session_id: 'c-1',
      transcript_path: '/tmp/rollout-c-1.jsonl',
      cwd: '/tmp',
      hook_event_name: 'SessionStart',
      source: 'startup',
    },
  });

  expect(ev).toStrictEqual({
    kind: 'started',
    agentSessionID: toAgentSessionID('c-1'),
    nameSource: 'c-1',
    transcriptSource: '/tmp/rollout-c-1.jsonl',
  });
});

test('it maps codex prompt, stop, permission, and end events to session kinds', () => {
  const adapter = new CodexAdapter(buildCodexConfig());

  const submitted = adapter.normalizeHook({
    atcId: toSessionID('s1'),
    event: 'UserPromptSubmit',
    payload: { session_id: 'c-1', prompt: 'do the thing' },
  });

  expect(submitted).toMatchObject({ kind: 'prompt-submitted', message: 'do the thing' });

  const stopped = adapter.normalizeHook({
    atcId: toSessionID('s1'),
    event: 'Stop',
    payload: { session_id: 'c-1', last_assistant_message: 'pong' },
  });

  expect(stopped).toMatchObject({ kind: 'turn-done', detail: 'pong' });

  const approval = adapter.normalizeHook({
    atcId: toSessionID('s1'),
    event: 'PermissionRequest',
    payload: { session_id: 'c-1', tool_name: 'shell' },
  });

  expect(approval).toMatchObject({ kind: 'needs-input', message: 'waiting for approval: shell' });

  const ended = adapter.normalizeHook({
    atcId: toSessionID('s1'),
    event: 'SessionEnd',
    payload: { session_id: 'c-1', reason: 'other' },
  });

  expect(ended).toStrictEqual({ kind: 'ended', agentSessionID: toAgentSessionID('c-1') });
});

test('it loads the latest indexed thread name but never over a user-typed name', async () => {
  setupCodexHome([
    '{"id":"c-1","thread_name":"first title","updated_at":"2026-08-20T00:00:00Z"}',
    '{"id":"c-2","thread_name":"other session","updated_at":"2026-08-20T00:00:01Z"}',
    '{"id":"c-1","thread_name":"renamed title","updated_at":"2026-08-20T00:00:02Z"}',
  ]);

  const adapter = new CodexAdapter(buildCodexConfig());

  const autoName = await adapter.loadName('c-1', 'auto');
  const userName = await adapter.loadName('c-1', 'user');
  const missingName = await adapter.loadName('c-missing', 'auto');

  expect(autoName).toStrictEqual({ name: 'renamed title' });
  expect(userName).toBeNull();
  expect(missingName).toBeNull();
});

test('it resumes when no transcript was reported or the reported rollout exists', () => {
  const dir = setupCodexHome([]);
  const rollout = join(dir, 'rollout.jsonl');

  writeFileSync(rollout, '');

  const adapter = new CodexAdapter(buildCodexConfig());

  expect(adapter.canResume({})).toBe(true);
  expect(adapter.canResume({ transcriptSource: rollout })).toBe(true);
  expect(adapter.canResume({ transcriptSource: join(dir, 'missing.jsonl') })).toBe(false);
});

test('it builds codex resume commands with and without a captured id', () => {
  const adapter = new CodexAdapter(buildCodexConfig());

  expect(adapter.buildResumeCommand("/tmp/it's", toAgentSessionID('c-1'))).toBe(
    String.raw`cd '/tmp/it'\''s' && codex resume c-1`,
  );

  expect(adapter.buildResumeCommand('/tmp', undefined)).toBe(`cd '/tmp' && codex resume`);
});
