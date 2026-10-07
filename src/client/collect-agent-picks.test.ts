import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../shared/config';
import { updateEnv } from '../test-utils/update-env';
import { collectAgentPicks } from './collect-agent-picks';

function setupBinDir(bins: readonly { readonly name: string; readonly executable: boolean }[]) {
  const prefix = join(tmpdir(), 'atc-picks-');
  const dir = realpathSync(mkdtempSync(prefix));

  for (const bin of bins) {
    writeFileSync(join(dir, bin.name), '#!/bin/sh\nexit 0\n', {
      mode: bin.executable ? 0o755 : 0o644,
    });
  }

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  return dir;
}

test('it lists only the agents whose configured binary resolves', () => {
  const dir = setupBinDir([
    { name: 'my-claude', executable: true },
    { name: 'my-codex', executable: true },
  ]);

  const config = parseConfig({
    agents: {
      claude: { bin: join(dir, 'my-claude') },
      grok: { bin: join(dir, 'my-grok') },
      codex: { bin: join(dir, 'my-codex') },
    },
  });

  expect(collectAgentPicks(config)).toStrictEqual([
    { agent: 'claude', label: 'Claude' },
    { agent: 'codex', label: 'Codex' },
  ]);
});

test('it lists a file with the old agent keys the same way', () => {
  const dir = setupBinDir([
    { name: 'my-claude', executable: true },
    { name: 'my-codex', executable: true },
  ]);

  const config = parseConfig({
    claudeBin: join(dir, 'my-claude'),
    grokBin: join(dir, 'my-grok'),
    codexBin: join(dir, 'my-codex'),
  });

  expect(collectAgentPicks(config)).toStrictEqual([
    { agent: 'claude', label: 'Claude' },
    { agent: 'codex', label: 'Codex' },
  ]);
});

test('it resolves a bare binary name off PATH', () => {
  const dir = setupBinDir([{ name: 'grok', executable: true }]);

  updateEnv('PATH', dir);

  const picks = collectAgentPicks(parseConfig({}));

  expect(picks).toStrictEqual([{ agent: 'grok', label: 'Grok' }]);
});

test('it leaves out a binary that exists without the executable bit', () => {
  const dir = setupBinDir([{ name: 'my-codex', executable: false }]);

  const config = parseConfig({
    agents: {
      claude: { bin: join(dir, 'my-claude') },
      codex: { bin: join(dir, 'my-codex') },
    },
  });

  expect(collectAgentPicks(config)).toStrictEqual([]);
});

test('it lists agents in registry order with their labels', () => {
  const dir = setupBinDir([{ name: 'my-claude', executable: true }]);

  const config = parseConfig({
    agents: {
      zai: {
        kind: 'claude',
        label: 'GLM (z.ai)',
        bin: join(dir, 'my-claude'),
        baseURL: 'https://api.z.ai/api/anthropic',
      },
      claude: { bin: join(dir, 'my-claude') },
      'claude-b': { kind: 'claude', bin: join(dir, 'my-claude') },
    },
  });

  expect(collectAgentPicks(config)).toStrictEqual([
    { agent: 'zai', label: 'GLM (z.ai)' },
    { agent: 'claude', label: 'Claude' },
    { agent: 'claude-b', label: 'claude-b' },
  ]);
});

test('it leaves out a configured backend whose binary does not resolve', () => {
  const dir = setupBinDir([{ name: 'my-claude', executable: true }]);

  const config = parseConfig({
    agents: {
      claude: { bin: join(dir, 'my-claude') },
      zai: {
        kind: 'claude',
        bin: join(dir, 'missing-claude'),
        baseURL: 'https://api.z.ai/api/anthropic',
      },
    },
  });

  expect(collectAgentPicks(config)).toStrictEqual([{ agent: 'claude', label: 'Claude' }]);
});

test('it lists a gateway with auth, which starts on a target with broker auth', () => {
  const dir = setupBinDir([{ name: 'my-claude', executable: true }]);

  const config = parseConfig({
    authProfiles: {
      glm: { secret: 'glm', host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
    },
    agents: {
      claude: { bin: join(dir, 'my-claude') },
      glm: {
        kind: 'claude',
        label: 'GLM',
        bin: join(dir, 'my-claude'),
        baseURL: 'https://api.z.ai/api/anthropic',
        auth: { profiles: ['glm'] },
      },
    },
  });

  expect(collectAgentPicks(config)).toStrictEqual([
    { agent: 'claude', label: 'Claude' },
    { agent: 'glm', label: 'GLM' },
  ]);
});

test('it lists no agent for an empty registry', () => {
  const picks = collectAgentPicks(parseConfig({ agents: {} }));

  expect(picks).toStrictEqual([]);
});
