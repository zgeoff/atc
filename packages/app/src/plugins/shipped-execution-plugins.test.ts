import { expect, test } from 'bun:test';
import { IMP_PLUGIN } from '@atc/execution-imp';
import { buildTargetIdentity } from '@atc/store';
import { SHIPPED_EXECUTION_PLUGINS } from './shipped-execution-plugins';

test('it ships the local PTY and imp execution plugins', () => {
  expect(SHIPPED_EXECUTION_PLUGINS.map((plugin) => plugin.id)).toStrictEqual(['local-pty', 'imp']);
});

// stored sessions hold this exact string for the config, so a change to it
// would refuse every one of them as bound to a changed target
test('it builds the imp identity a stored session holds for a fixed config', () => {
  expect(
    buildTargetIdentity(
      'imp',
      {
        url: 'http://impd.example:7070',
        tokenEnv: 'EXAMPLE_TOKEN',
        image: 'dev',
        memoryMib: 4096,
        guestATC: 'bundled',
        rebindChangedAuth: true,
        dropSysAdmin: true,
        trustClonedWorkspace: true,
      },
      IMP_PLUGIN.identity,
    ),
  ).toBe('imp:reach-v1:6b55bacee6685673');
});

test.each([
  ['image', 'dev', 'ci'],
  ['guestATC', '/usr/bin/atc', '/opt/atc'],
  ['memoryMib', 2048, 4096],
  ['rebindChangedAuth', false, true],
])('it preserves the imp identity when %s changes', (key, before, after) => {
  expect(buildTargetIdentity('imp', { [key]: before }, IMP_PLUGIN.identity)).toBe(
    buildTargetIdentity('imp', { [key]: after }, IMP_PLUGIN.identity),
  );
});

test.each([
  ['url', 'http://server-a', 'http://server-b'],
  ['tokenEnv', 'TOKEN_A', 'TOKEN_B'],
  ['tokenFile', '/tokens/a', '/tokens/b'],
  ['impPrefix', 'home-', 'work-'],
  ['guestDir', '/tmp/atc', '/opt/atc'],
  ['dropSysAdmin', false, true],
  ['trustClonedWorkspace', false, true],
])('it builds another imp identity when %s changes', (key, before, after) => {
  expect(buildTargetIdentity('imp', { [key]: before }, IMP_PLUGIN.identity)).not.toBe(
    buildTargetIdentity('imp', { [key]: after }, IMP_PLUGIN.identity),
  );
});
