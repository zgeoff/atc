import { expect, test } from 'bun:test';
import { parseConfig } from '@atc/config';
import { buildStubHarnessPlugins } from '@atc/config/test-utils/build-stub-harness-plugins';
import { pickConfigReload } from './pick-config-reload';

test('it applies a config with no problem and takes its default target', () => {
  const config = parseConfig(buildStubHarnessPlugins(), {}, '/c.json');

  expect(pickConfigReload(config)).toStrictEqual({
    kind: 'apply',
    keepDefaultTarget: false,
    lines: [],
  });
});

test('it refuses a root that is not an object and names the cause', () => {
  const config = parseConfig(buildStubHarnessPlugins(), 'text', '/c.json');

  expect(pickConfigReload(config)).toStrictEqual({
    kind: 'refuse',
    cause: '/c.json cannot be used: config_malformed, the root is a string, not an object',
  });
});

test.each([
  {
    title: 'a default that matches no target',
    raw: { targets: { box: { provider: 'local-pty' } }, defaultTarget: 'ghost' },
    line: 'atc daemon: config: defaultTarget: matches no well-formed target in targets',
  },
  {
    title: 'a default that is not a string',
    raw: { defaultTarget: 5 },
    line: 'atc daemon: config: defaultTarget: expected a string, got a number',
  },
])('it keeps the old default target and prints the problem for $title', (row) => {
  const config = parseConfig(buildStubHarnessPlugins(), row.raw, '/c.json');

  expect(pickConfigReload(config)).toStrictEqual({
    kind: 'apply',
    keepDefaultTarget: true,
    lines: [row.line],
  });
});

test('it prints an entry problem and still applies the config', () => {
  const config = parseConfig(
    buildStubHarnessPlugins(),
    { agents: { codex: { kind: 'codex', baseURL: 'nope' } } },
    '/c.json',
  );

  expect(pickConfigReload(config)).toStrictEqual({
    kind: 'apply',
    keepDefaultTarget: false,
    lines: ['atc daemon: config: agents.codex: baseURL is not valid for kind codex'],
  });
});
