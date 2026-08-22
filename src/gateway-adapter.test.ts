import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from './config';
import { GatewayAdapter } from './gateway-adapter';
import { toAgentSessionID } from './to-agent-session-id';
import { toSessionID } from './to-session-id';

function buildGatewayAdapter(): GatewayAdapter {
  const config: Config = {
    claudeBin: 'claude',
    claudeArgs: [],
    grokBin: 'grok',
    grokArgs: [],
    codexBin: 'codex',
    codexArgs: [],
    gateways: [],
    leader: { code: 0, label: '^Space' },
  };

  return new GatewayAdapter(
    {
      id: 'zai',
      label: 'GLM (z.ai)',
      mark: 'z',
      bin: 'claude',
      args: [],
      baseURL: 'https://api.z.ai/api/anthropic',
      env: {},
    },
    config,
  );
}

test('it answers to the id its backend was configured under', () => {
  expect(buildGatewayAdapter().id).toBe('zai');
});

test('it runs no headless turn when the daemon gave it no runner', () => {
  expect(buildGatewayAdapter().headlessRunner).toBeNull();
});

test('it reads a session id and transcript out of a Claude hook payload', () => {
  const adapter = buildGatewayAdapter();

  expect(
    adapter.normalizeHook({
      atcId: toSessionID('s1'),
      event: 'SessionStart',
      payload: { session_id: 'z-1', transcript_path: '/tmp/t.jsonl' },
    }),
  ).toStrictEqual({
    kind: 'started',

    agentSessionID: toAgentSessionID('z-1'),
    nameSource: '/tmp/t.jsonl',
    transcriptSource: '/tmp/t.jsonl',
  });
});

test('it resumes only while the reported transcript is still on disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atc-gateway-resume-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const transcript = join(dir, 'transcript.jsonl');

  writeFileSync(transcript, '');

  const adapter = buildGatewayAdapter();

  expect(adapter.canResume({ transcriptSource: transcript })).toBe(true);
  expect(adapter.canResume({ transcriptSource: join(dir, 'missing.jsonl') })).toBe(false);
});
