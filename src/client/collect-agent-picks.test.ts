import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  expect(
    collectAgentPicks({
      claudeBin: join(dir, 'my-claude'),
      claudeArgs: [],
      grokBin: join(dir, 'my-grok'),
      grokArgs: [],
      codexBin: join(dir, 'my-codex'),
      codexArgs: [],
      gateways: [],
      hooks: {},
      leader: { code: 0, label: '^Space' },
    }),
  ).toStrictEqual([
    { agent: 'claude', label: 'Claude' },
    { agent: 'codex', label: 'Codex' },
  ]);
});

test('it resolves a bare binary name off PATH', () => {
  const dir = setupBinDir([{ name: 'grok', executable: true }]);
  const prev = process.env['PATH'];

  process.env['PATH'] = dir;

  onTestFinished(() => {
    process.env['PATH'] = prev;
  });

  expect(
    collectAgentPicks({
      claudeBin: 'claude',
      claudeArgs: [],
      grokBin: 'grok',
      grokArgs: [],
      codexBin: 'codex',
      codexArgs: [],
      gateways: [],
      hooks: {},
      leader: { code: 0, label: '^Space' },
    }),
  ).toStrictEqual([{ agent: 'grok', label: 'Grok' }]);
});

test('it leaves out a binary that exists without the executable bit', () => {
  const dir = setupBinDir([{ name: 'my-codex', executable: false }]);

  expect(
    collectAgentPicks({
      claudeBin: join(dir, 'my-claude'),
      claudeArgs: [],
      grokBin: join(dir, 'my-grok'),
      grokArgs: [],
      codexBin: join(dir, 'my-codex'),
      codexArgs: [],
      gateways: [],
      hooks: {},
      leader: { code: 0, label: '^Space' },
    }),
  ).toStrictEqual([]);
});

test('it lists a configured backend after the built-in agents', () => {
  const dir = setupBinDir([{ name: 'my-claude', executable: true }]);

  expect(
    collectAgentPicks({
      claudeBin: join(dir, 'my-claude'),
      claudeArgs: [],
      grokBin: join(dir, 'my-grok'),
      grokArgs: [],
      codexBin: join(dir, 'my-codex'),
      codexArgs: [],
      gateways: [
        {
          id: 'zai',
          label: 'GLM (z.ai)',
          mark: 'z',
          bin: join(dir, 'my-claude'),
          args: [],
          baseURL: 'https://api.z.ai/api/anthropic',
          env: {},
        },
      ],
      hooks: {},
      leader: { code: 0, label: '^Space' },
    }),
  ).toStrictEqual([
    { agent: 'claude', label: 'Claude' },
    { agent: 'zai', label: 'GLM (z.ai)' },
  ]);
});

test('it leaves out a configured backend whose binary does not resolve', () => {
  const dir = setupBinDir([{ name: 'my-claude', executable: true }]);

  expect(
    collectAgentPicks({
      claudeBin: join(dir, 'my-claude'),
      claudeArgs: [],
      grokBin: join(dir, 'my-grok'),
      grokArgs: [],
      codexBin: join(dir, 'my-codex'),
      codexArgs: [],
      gateways: [
        {
          id: 'zai',
          label: 'GLM (z.ai)',
          mark: 'z',
          bin: join(dir, 'missing-claude'),
          args: [],
          baseURL: 'https://api.z.ai/api/anthropic',
          env: {},
        },
      ],
      hooks: {},
      leader: { code: 0, label: '^Space' },
    }),
  ).toStrictEqual([{ agent: 'claude', label: 'Claude' }]);
});
