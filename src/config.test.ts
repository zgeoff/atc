import { expect, test } from 'bun:test';
import { parseConfig } from './config';

test('it falls back to every default when the file is not an object', () => {
  expect(parseConfig(null)).toStrictEqual({
    claudeBin: 'claude',
    claudeArgs: [],
    grokBin: 'grok',
    grokArgs: [],
    codexBin: 'codex',
    codexArgs: [],
    gateways: [],
    leader: { code: 0, label: '^Space' },
  });

  expect(parseConfig([])).toStrictEqual(parseConfig(undefined));
  expect(parseConfig('garbage')).toStrictEqual(parseConfig(undefined));
  expect(parseConfig(42)).toStrictEqual(parseConfig(undefined));
});

test('it falls back field by field when a field is wrong-typed instead of failing the whole file', () => {
  const config = parseConfig({
    claudeBin: 7,
    claudeArgs: 'not-an-array',
    grokBin: 'my-grok',
    grokArgs: ['--yolo', 3, null],
    leader: 3,
  });

  expect(config).toStrictEqual({
    claudeBin: 'claude',
    claudeArgs: [],
    grokBin: 'my-grok',
    grokArgs: ['--yolo'],
    codexBin: 'codex',
    codexArgs: [],
    gateways: [],
    leader: { code: 0, label: '^Space' },
  });
});

test('it decodes a configured leader key and falls back to the default for an unknown one', () => {
  expect(parseConfig({ leader: 'ctrl-a' }).leader).toStrictEqual({ code: 1, label: '^A' });
  expect(parseConfig({ leader: 'ctrl-nope' }).leader).toStrictEqual({ code: 0, label: '^Space' });
});

test('it collects the configured gateway map using the parsed claude bin and args', () => {
  const config = parseConfig({
    claudeBin: '/opt/claude',
    claudeArgs: ['--verbose'],
    gateways: { zai: { baseURL: 'https://api.z.ai/api/anthropic' } },
  });

  expect(config.gateways).toStrictEqual([
    {
      id: 'zai',
      label: 'zai',
      mark: 'z',
      bin: '/opt/claude',
      args: ['--verbose'],
      baseURL: 'https://api.z.ai/api/anthropic',
      env: {},
    },
  ]);
});
