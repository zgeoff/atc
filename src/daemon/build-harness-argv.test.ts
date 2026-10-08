import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { createStubBin } from '../test-utils/create-stub-bin';
import { runCommand } from '../test-utils/run-command';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { buildHarnessArgv } from './build-harness-argv';

function setupTest() {
  const tmp = setupTempDir('atc-harness-argv-');

  return { dir: tmp.dir };
}

test('it unsets the names and starts the program after the separator', () => {
  expect(
    buildHarnessArgv({
      unset: ['ATC_TEST_A', 'ATC_TEST_B'],
      env: { PATH: '/usr/bin:/bin', DYLD_ATC_TEST: 'synthetic' },
      platform: 'linux',
      bin: '/opt/agent/claude',
      args: ['--resume', 'x'],
    }),
  ).toStrictEqual([
    '-u',
    'ATC_TEST_A',
    '-u',
    'ATC_TEST_B',
    '--',
    '/opt/agent/claude',
    '--resume',
    'x',
  ]);
});

test('it sets the DYLD_ entries again as assignments before the program on macOS', () => {
  expect(
    buildHarnessArgv({
      unset: ['ATC_TEST_A'],
      env: { PATH: '/usr/bin:/bin', DYLD_ATC_TEST: 'synthetic' },
      platform: 'darwin',
      bin: '/opt/agent/claude',
      args: ['--resume'],
    }),
  ).toStrictEqual([
    '-u',
    'ATC_TEST_A',
    '--',
    'DYLD_ATC_TEST=synthetic',
    '/opt/agent/claude',
    '--resume',
  ]);
});

test('it exports the DYLD_ entries inside the shell for a program path holding = on macOS', () => {
  expect(
    buildHarnessArgv({
      unset: [],
      env: { PATH: '/usr/bin:/bin', DYLD_ATC_TEST: 'one', DYLD_ATC_OTHER: 'two' },
      platform: 'darwin',
      bin: '/opt/agent=dir/claude',
      args: ['--resume'],
    }),
  ).toMatchInlineSnapshot(`
    [
      "--",
      "/bin/sh",
      "-c",
      "export DYLD_ATC_TEST="\${1}" DYLD_ATC_OTHER="\${2}"; shift 2; exec "$0" "$@"",
      "/opt/agent=dir/claude",
      "one",
      "two",
      "--resume",
    ]
  `);
});

test('it starts a program path holding = with a DYLD_ value that holds quotes, spaces and $ exactly', async () => {
  const ctx = setupTest();

  const bin = createStubBin(
    join(ctx.dir, 'agent=dir'),
    'agent',
    '#!/bin/sh\nprintf \'DYLD:[%s] ARGS:[%s|%s]\' "$DYLD_ATC_TEST" "$1" "$2"\n',
  );

  const value = `it's a "quoted" value with $HOME, \`true\`, $(true) and a \\ backslash`;

  const result = await runCommand(
    [
      '/usr/bin/env',
      ...buildHarnessArgv({
        unset: [],
        env: { DYLD_ATC_TEST: value },
        platform: 'darwin',
        bin,
        args: ['first arg', '$HOME'],
      }),
    ],
    { env: { PATH: '/usr/bin:/bin', HOME: ctx.dir } },
  );

  expect(result.stdout).toBe(`DYLD:[${value}] ARGS:[first arg|$HOME]`);
});

test('it starts a program path holding = with ten DYLD_ values, each under its own name', async () => {
  const ctx = setupTest();

  const bin = createStubBin(
    join(ctx.dir, 'agent=dir'),
    'agent',
    '#!/bin/sh\nprintf \'FIRST:[%s] TENTH:[%s] ARG:[%s]\' "$DYLD_ATC_1" "$DYLD_ATC_10" "$1"\n',
  );

  const result = await runCommand(
    [
      '/usr/bin/env',
      ...buildHarnessArgv({
        unset: [],
        env: {
          DYLD_ATC_1: 'one',
          DYLD_ATC_2: 'two',
          DYLD_ATC_3: 'three',
          DYLD_ATC_4: 'four',
          DYLD_ATC_5: 'five',
          DYLD_ATC_6: 'six',
          DYLD_ATC_7: 'seven',
          DYLD_ATC_8: 'eight',
          DYLD_ATC_9: 'nine',
          DYLD_ATC_10: 'ten',
        },
        platform: 'darwin',
        bin,
        args: ['first arg'],
      }),
    ],
    { env: { PATH: '/usr/bin:/bin' } },
  );

  expect(result.stdout).toBe('FIRST:[one] TENTH:[ten] ARG:[first arg]');
});

test('it starts a program path holding = when a DYLD_ name is one the shell cannot export', async () => {
  const ctx = setupTest();

  const bin = createStubBin(
    join(ctx.dir, 'agent=dir'),
    'agent',
    '#!/bin/sh\nprintf \'RAN:[%s]\' "$1"\n',
  );

  const result = await runCommand(
    [
      '/usr/bin/env',
      ...buildHarnessArgv({
        unset: [],
        env: { 'DYLD_ATC-TEST': 'synthetic' },
        platform: 'darwin',
        bin,
        args: ['first arg'],
      }),
    ],
    { env: { PATH: '/usr/bin:/bin' } },
  );

  expect(result.stdout).toBe('RAN:[first arg]');
});
