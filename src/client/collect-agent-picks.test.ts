import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseConfig } from '../shared/config';
import { createStubBin } from '../test-utils/create-stub-bin';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { updateEnv } from '../test-utils/update-env';
import { collectAgentPicks } from './collect-agent-picks';

function setupTest() {
  const tmp = setupTempDir('atc-picks-');

  return { dir: tmp.dir, [Symbol.dispose]: tmp[Symbol.dispose] };
}

test('it lists only the agents whose configured binary resolves', () => {
  using ctx = setupTest();

  createStubBin(ctx.dir, 'my-claude', '#!/bin/sh\nexit 0\n');
  createStubBin(ctx.dir, 'my-codex', '#!/bin/sh\nexit 0\n');

  const config = parseConfig({
    agents: {
      claude: { bin: join(ctx.dir, 'my-claude') },
      grok: { bin: join(ctx.dir, 'my-grok') },
      codex: { bin: join(ctx.dir, 'my-codex') },
    },
  });

  expect(collectAgentPicks(config)).toStrictEqual([
    { agent: 'claude', label: 'Claude' },
    { agent: 'codex', label: 'Codex' },
  ]);
});

test('it lists only the agents whose binary resolves from a config with the old agent keys', () => {
  using ctx = setupTest();

  createStubBin(ctx.dir, 'my-claude', '#!/bin/sh\nexit 0\n');
  createStubBin(ctx.dir, 'my-codex', '#!/bin/sh\nexit 0\n');

  const config = parseConfig({
    claudeBin: join(ctx.dir, 'my-claude'),
    grokBin: join(ctx.dir, 'my-grok'),
    codexBin: join(ctx.dir, 'my-codex'),
  });

  expect(collectAgentPicks(config)).toStrictEqual([
    { agent: 'claude', label: 'Claude' },
    { agent: 'codex', label: 'Codex' },
  ]);
});

test('it resolves a bare binary name off PATH', () => {
  using ctx = setupTest();

  createStubBin(ctx.dir, 'grok', '#!/bin/sh\nexit 0\n');
  updateEnv('PATH', ctx.dir);

  const picks = collectAgentPicks(parseConfig({}));

  expect(picks).toStrictEqual([{ agent: 'grok', label: 'Grok' }]);
});

test('it leaves out a binary that exists without the executable bit', () => {
  using ctx = setupTest();

  writeFileSync(join(ctx.dir, 'my-codex'), '#!/bin/sh\nexit 0\n', { mode: 0o644 });

  const config = parseConfig({
    agents: {
      claude: { bin: join(ctx.dir, 'my-claude') },
      codex: { bin: join(ctx.dir, 'my-codex') },
    },
  });

  expect(collectAgentPicks(config)).toStrictEqual([]);
});

test('it lists agents in registry order with their labels', () => {
  using ctx = setupTest();

  createStubBin(ctx.dir, 'my-claude', '#!/bin/sh\nexit 0\n');

  const config = parseConfig({
    agents: {
      zai: {
        kind: 'claude',
        label: 'GLM (z.ai)',
        bin: join(ctx.dir, 'my-claude'),
        baseURL: 'https://api.z.ai/api/anthropic',
      },
      claude: { bin: join(ctx.dir, 'my-claude') },
      'claude-b': { kind: 'claude', bin: join(ctx.dir, 'my-claude') },
    },
  });

  expect(collectAgentPicks(config)).toStrictEqual([
    { agent: 'zai', label: 'GLM (z.ai)' },
    { agent: 'claude', label: 'Claude' },
    { agent: 'claude-b', label: 'claude-b' },
  ]);
});

test('it leaves out a configured backend whose binary does not resolve', () => {
  using ctx = setupTest();

  createStubBin(ctx.dir, 'my-claude', '#!/bin/sh\nexit 0\n');

  const config = parseConfig({
    agents: {
      claude: { bin: join(ctx.dir, 'my-claude') },
      zai: {
        kind: 'claude',
        bin: join(ctx.dir, 'missing-claude'),
        baseURL: 'https://api.z.ai/api/anthropic',
      },
    },
  });

  expect(collectAgentPicks(config)).toStrictEqual([{ agent: 'claude', label: 'Claude' }]);
});

test('it lists a gateway with auth, which starts on a target with broker auth', () => {
  using ctx = setupTest();

  createStubBin(ctx.dir, 'my-claude', '#!/bin/sh\nexit 0\n');

  const config = parseConfig({
    authProfiles: {
      glm: { secret: 'glm', host: 'api.z.ai', header: 'authorization', scheme: 'bearer' },
    },
    agents: {
      claude: { bin: join(ctx.dir, 'my-claude') },
      glm: {
        kind: 'claude',
        label: 'GLM',
        bin: join(ctx.dir, 'my-claude'),
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
