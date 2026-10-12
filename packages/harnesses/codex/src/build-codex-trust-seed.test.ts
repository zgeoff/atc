import { expect, test } from 'bun:test';
import { buildCodexTrustSeed } from './build-codex-trust-seed';

test('it trusts the exact clone root in a projects table appended to the config', () => {
  expect(buildCodexTrustSeed('/home/agent/work/app')).toStrictEqual({
    'codex-trust.toml': '\n[projects."/home/agent/work/app"]\ntrust_level = "trusted"\n',
  });
});

test('it quotes a root with a quote or a backslash as a TOML basic string', () => {
  expect(buildCodexTrustSeed(String.raw`/work/a"b\c`)).toStrictEqual({
    'codex-trust.toml': '\n[projects."/work/a\\"b\\\\c"]\ntrust_level = "trusted"\n',
  });
});
