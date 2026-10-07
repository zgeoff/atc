import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseConfig } from '../shared/config';
import { createStubBin } from '../test-utils/create-stub-bin';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { updateEnv } from '../test-utils/update-env';
import { collectAgentPicks } from './collect-agent-picks';

test('it lists only the agents whose configured binary resolves', () => {
  using tmp = setupTempDir('atc-picks-');

  createStubBin(tmp.dir, 'my-claude', '#!/bin/sh\nexit 0\n');
  createStubBin(tmp.dir, 'my-codex', '#!/bin/sh\nexit 0\n');

  const config = parseConfig({
    agents: {
      claude: { bin: join(tmp.dir, 'my-claude') },
      grok: { bin: join(tmp.dir, 'my-grok') },
      codex: { bin: join(tmp.dir, 'my-codex') },
    },
  });

  expect(collectAgentPicks(config)).toStrictEqual([
    { agent: 'claude', label: 'Claude' },
    { agent: 'codex', label: 'Codex' },
  ]);
});

test('it lists only the agents whose binary resolves from a config with the old agent keys', () => {
  using tmp = setupTempDir('atc-picks-');

  createStubBin(tmp.dir, 'my-claude', '#!/bin/sh\nexit 0\n');
  createStubBin(tmp.dir, 'my-codex', '#!/bin/sh\nexit 0\n');

  const config = parseConfig({
    claudeBin: join(tmp.dir, 'my-claude'),
    grokBin: join(tmp.dir, 'my-grok'),
    codexBin: join(tmp.dir, 'my-codex'),
  });

  expect(collectAgentPicks(config)).toStrictEqual([
    { agent: 'claude', label: 'Claude' },
    { agent: 'codex', label: 'Codex' },
  ]);
});

test('it resolves a bare binary name off PATH', () => {
  using tmp = setupTempDir('atc-picks-');

  createStubBin(tmp.dir, 'grok', '#!/bin/sh\nexit 0\n');
  updateEnv('PATH', tmp.dir);

  const picks = collectAgentPicks(parseConfig({}));

  expect(picks).toStrictEqual([{ agent: 'grok', label: 'Grok' }]);
});

test('it leaves out a binary that exists without the executable bit', () => {
  using tmp = setupTempDir('atc-picks-');

  writeFileSync(join(tmp.dir, 'my-codex'), '#!/bin/sh\nexit 0\n', { mode: 0o644 });

  const config = parseConfig({
    agents: {
      claude: { bin: join(tmp.dir, 'my-claude') },
      codex: { bin: join(tmp.dir, 'my-codex') },
    },
  });

  expect(collectAgentPicks(config)).toStrictEqual([]);
});

test('it lists agents in registry order with their labels', () => {
  using tmp = setupTempDir('atc-picks-');

  createStubBin(tmp.dir, 'my-claude', '#!/bin/sh\nexit 0\n');

  const config = parseConfig({
    agents: {
      zai: {
        kind: 'claude',
        label: 'GLM (z.ai)',
        bin: join(tmp.dir, 'my-claude'),
        baseURL: 'https://api.z.ai/api/anthropic',
      },
      claude: { bin: join(tmp.dir, 'my-claude') },
      'claude-b': { kind: 'claude', bin: join(tmp.dir, 'my-claude') },
    },
  });

  expect(collectAgentPicks(config)).toStrictEqual([
    { agent: 'zai', label: 'GLM (z.ai)' },
    { agent: 'claude', label: 'Claude' },
    { agent: 'claude-b', label: 'claude-b' },
  ]);
});

test('it leaves out a configured backend whose binary does not resolve', () => {
  using tmp = setupTempDir('atc-picks-');

  createStubBin(tmp.dir, 'my-claude', '#!/bin/sh\nexit 0\n');

  const config = parseConfig({
    agents: {
      claude: { bin: join(tmp.dir, 'my-claude') },
      zai: {
        kind: 'claude',
        bin: join(tmp.dir, 'missing-claude'),
        baseURL: 'https://api.z.ai/api/anthropic',
      },
    },
  });

  expect(collectAgentPicks(config)).toStrictEqual([{ agent: 'claude', label: 'Claude' }]);
});

test('it lists a gateway with auth, which starts on a target with broker auth', () => {
  using tmp = setupTempDir('atc-picks-');

  createStubBin(tmp.dir, 'my-claude', '#!/bin/sh\nexit 0\n');

  const config = parseConfig({
    authProfiles: {
      glm: { secret: 'glm', host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
    },
    agents: {
      claude: { bin: join(tmp.dir, 'my-claude') },
      glm: {
        kind: 'claude',
        label: 'GLM',
        bin: join(tmp.dir, 'my-claude'),
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
