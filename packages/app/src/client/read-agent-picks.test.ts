import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseConfig } from '@atc/config';
import { createStubBin, setupTempDir, updateEnv } from '@atc/test-utils';
import { SHIPPED_HARNESS_PLUGINS } from '../plugins/shipped-harness-plugins';
import { readAgentPicks } from './read-agent-picks';

function setupTest() {
  const tmp = setupTempDir('atc-picks-');

  return { dir: tmp.path };
}

test('it lists only the agents whose configured binary resolves', () => {
  const ctx = setupTest();

  createStubBin(ctx.dir, 'my-claude', '#!/bin/sh\nexit 0\n');
  createStubBin(ctx.dir, 'my-codex', '#!/bin/sh\nexit 0\n');

  const config = parseConfig(SHIPPED_HARNESS_PLUGINS, {
    agents: {
      claude: { bin: join(ctx.dir, 'my-claude') },
      grok: { bin: join(ctx.dir, 'my-grok') },
      codex: { bin: join(ctx.dir, 'my-codex') },
    },
  });

  expect(readAgentPicks(config)).toStrictEqual([
    { agent: 'claude', label: 'Claude' },
    { agent: 'codex', label: 'Codex' },
  ]);
});

test('it resolves a bare binary name off PATH', () => {
  const ctx = setupTest();

  createStubBin(ctx.dir, 'grok', '#!/bin/sh\nexit 0\n');
  updateEnv('PATH', ctx.dir);

  const picks = readAgentPicks(parseConfig(SHIPPED_HARNESS_PLUGINS, {}));

  expect(picks).toStrictEqual([{ agent: 'grok', label: 'Grok' }]);
});

test('it leaves out a binary that exists without the executable bit', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.dir, 'my-codex'), '#!/bin/sh\nexit 0\n', { mode: 0o644 });

  const config = parseConfig(SHIPPED_HARNESS_PLUGINS, {
    agents: {
      claude: { bin: join(ctx.dir, 'my-claude') },
      codex: { bin: join(ctx.dir, 'my-codex') },
    },
  });

  expect(readAgentPicks(config)).toStrictEqual([]);
});

test('it lists agents in registry order with their labels', () => {
  const ctx = setupTest();

  createStubBin(ctx.dir, 'my-claude', '#!/bin/sh\nexit 0\n');

  const config = parseConfig(SHIPPED_HARNESS_PLUGINS, {
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

  expect(readAgentPicks(config)).toStrictEqual([
    { agent: 'zai', label: 'GLM (z.ai)' },
    { agent: 'claude', label: 'Claude' },
    { agent: 'claude-b', label: 'claude-b' },
  ]);
});

test('it leaves out a configured backend whose binary does not resolve', () => {
  const ctx = setupTest();

  createStubBin(ctx.dir, 'my-claude', '#!/bin/sh\nexit 0\n');

  const config = parseConfig(SHIPPED_HARNESS_PLUGINS, {
    agents: {
      claude: { bin: join(ctx.dir, 'my-claude') },
      zai: {
        kind: 'claude',
        bin: join(ctx.dir, 'missing-claude'),
        baseURL: 'https://api.z.ai/api/anthropic',
      },
    },
  });

  expect(readAgentPicks(config)).toStrictEqual([{ agent: 'claude', label: 'Claude' }]);
});

test('it lists a gateway whose entry carries auth profiles', () => {
  const ctx = setupTest();

  createStubBin(ctx.dir, 'my-claude', '#!/bin/sh\nexit 0\n');

  const config = parseConfig(SHIPPED_HARNESS_PLUGINS, {
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

  expect(readAgentPicks(config)).toStrictEqual([
    { agent: 'claude', label: 'Claude' },
    { agent: 'glm', label: 'GLM' },
  ]);
});

test('it lists no agent for an empty registry', () => {
  const picks = readAgentPicks(parseConfig(SHIPPED_HARNESS_PLUGINS, { agents: {} }));

  expect(picks).toStrictEqual([]);
});
