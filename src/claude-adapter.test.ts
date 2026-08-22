import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeAdapter } from './claude-adapter';
import type { Config } from './config';
import { toSessionID } from './to-session-id';

function buildClaudeConfig(): Config {
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

test('it resumes when no transcript was reported or the reported file exists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atc-claude-resume-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const transcript = join(dir, 'transcript.jsonl');

  writeFileSync(transcript, '');

  const adapter = new ClaudeAdapter(buildClaudeConfig());

  expect(adapter.canResume({})).toBe(true);
  expect(adapter.canResume({ transcriptSource: transcript })).toBe(true);
  expect(adapter.canResume({ transcriptSource: join(dir, 'missing.jsonl') })).toBe(false);
});

test('it maps a non-object hook payload to a bare heartbeat instead of throwing', () => {
  const adapter = new ClaudeAdapter(buildClaudeConfig());

  const ev = adapter.normalizeHook({
    atcId: toSessionID('s1'),
    event: 'Stop',

    // oxlint-disable-next-line no-unsafe-type-assertion -- exercising a payload shape the HookEvent type rules out but a hostile or buggy reporter could still send
    payload: 'garbage' as unknown as Record<string, unknown>,
  });

  expect(ev).toStrictEqual({ kind: 'turn-done' });
});

test('it treats wrong-typed hook payload fields as absent instead of throwing', () => {
  const adapter = new ClaudeAdapter(buildClaudeConfig());

  const ev = adapter.normalizeHook({
    atcId: toSessionID('s1'),
    event: 'Stop',
    payload: { session_id: 42, transcript_path: null, last_assistant_message: ['pong'] },
  });

  expect(ev).toStrictEqual({ kind: 'turn-done' });
});
