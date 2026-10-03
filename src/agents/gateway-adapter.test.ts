import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupTempDir } from '../../test/setup-temp-dir';
import type { Config } from '../shared/config';
import { toAgentSessionID } from '../shared/to-agent-session-id';
import { toSessionID } from '../shared/to-session-id';
import { GatewayAdapter } from './gateway-adapter';

function buildGatewayAdapter(): GatewayAdapter {
  const config: Config = {
    claudeBin: 'claude',
    claudeArgs: [],
    grokBin: 'grok',
    grokArgs: [],
    codexBin: 'codex',
    codexArgs: [],
    dirs: { roots: [] },
    gateways: [],
    hooks: {},
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

test('it takes inbox messages', () => {
  const adapter = buildGatewayAdapter();

  expect(adapter.takesMessages).toBe(true);
});

test('it hands a headless run the settings file and the folder of the atc-bridge mod', () => {
  using tmp = setupTempDir('atc-gateway-bridge-');

  let received: Readonly<Record<string, unknown>> = {};

  const adapter = new GatewayAdapter(
    {
      id: 'zai',
      label: 'GLM (z.ai)',
      mark: 'z',
      bin: 'claude',
      args: [],
      baseURL: 'https://api.z.ai/api/anthropic',
      env: {},
    },
    {
      claudeBin: 'claude',
      claudeArgs: [],
      grokBin: 'grok',
      grokArgs: [],
      codexBin: 'codex',
      codexArgs: [],
      dirs: { roots: [] },
      gateways: [],
      hooks: {},
      leader: { code: 0, label: '^Space' },
    },
    (opts) => {
      received = { ...opts };

      return { stop: () => {} };
    },
    join(tmp.dir, 'atc-bridge'),
  );

  adapter.headlessRunner?.(
    { cwd: '/tmp', prompt: 'go' },
    { onOutput: () => {}, onDone: () => {}, onNeedsYou: () => {} },
  );

  expect(received).toMatchObject({
    settings: expect.toEndWith('.json'),
    pluginDir: expect.toEndWith('atc-bridge'),
  });
});

test('it profiles a gateway with only the model names its env sets', () => {
  const adapter = new GatewayAdapter(
    {
      id: 'zai',
      label: 'GLM (z.ai)',
      mark: 'z',
      bin: '/opt/claude/bin/claude',
      args: [],
      baseURL: 'https://api.z.ai/api/anthropic',
      apiKeyHelper: 'op read op://vault/zai/key',
      env: {
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-4.6',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-4.5-air',
        ANTHROPIC_MODEL: 'glm-4.6',
        ANTHROPIC_AUTH_TOKEN: 'sk-secret',
        API_TIMEOUT_MS: '600000',
      },
    },
    {
      claudeBin: 'claude',
      claudeArgs: [],
      grokBin: 'grok',
      grokArgs: [],
      codexBin: 'codex',
      codexArgs: [],
      dirs: { roots: [] },
      gateways: [],
      hooks: {},
      leader: { code: 0, label: '^Space' },
    },
  );

  expect(adapter.profile).toStrictEqual({
    label: 'GLM (z.ai)',
    kind: 'gateway',
    bin: '/opt/claude/bin/claude',
    models: { opus: 'glm-4.6', haiku: 'glm-4.5-air', default: 'glm-4.6' },
  });
});

test('it profiles a gateway whose env sets no model with no models', () => {
  expect(buildGatewayAdapter().profile.models).toBeNull();
});
