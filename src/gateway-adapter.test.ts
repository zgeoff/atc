import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentSessionID } from './agent-session-id';
import type { Config } from './config';
import { GatewayAdapter } from './gateway-adapter';
import type { SessionID } from './session-id';

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
      // oxlint-disable-next-line no-unsafe-type-assertion -- test fixture literal stands in for a minted session id
      atcId: 's1' as SessionID,
      event: 'SessionStart',
      payload: { session_id: 'z-1', transcript_path: '/tmp/t.jsonl' },
    }),
  ).toStrictEqual({
    kind: 'started',

    // oxlint-disable-next-line no-unsafe-type-assertion -- test fixture literal stands in for an agent-minted session id
    agentSessionID: 'z-1' as AgentSessionID,
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
