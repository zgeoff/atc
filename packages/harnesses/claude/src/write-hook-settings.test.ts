import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { toAgentID } from '@atc/core';
import { setupTempDir, updateEnv } from '@atc/test-utils';
import { writeHookSettings } from './write-hook-settings';

// A state folder for the settings file and a home for the Claude settings
// a test writes.
function setupTest() {
  const temporaryDirectory = setupTempDir('atc-hook-settings-');

  return {
    stateDir: join(temporaryDirectory.path, 'state'),
    home: join(temporaryDirectory.path, 'home'),
  };
}

test('it writes one settings file per agent id into the state folder', () => {
  const ctx = setupTest();

  updateEnv('CLAUDE_CONFIG_DIR', undefined);

  const file = writeHookSettings(
    { id: toAgentID('zai') },
    ['/opt/atc/bin/atc'],
    ctx.stateDir,
    ctx.home,
  );

  expect(file).toBe(join(ctx.stateDir, 'hook-settings-zai.json'));

  expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({
    statusLine: { command: '"/opt/atc/bin/atc" statusline --agent=\'zai\'', padding: 0 },
  });
});

test('it takes the padding of the statusline in the config folder CLAUDE_CONFIG_DIR sets', () => {
  const ctx = setupTest();
  const configDir = join(ctx.home, 'claude-config');

  mkdirSync(configDir, { recursive: true });

  writeFileSync(
    join(configDir, 'settings.json'),
    '{"statusLine":{"command":"ccline","padding":2}}',
  );

  updateEnv('CLAUDE_CONFIG_DIR', configDir);

  const file = writeHookSettings(
    { id: toAgentID('claude') },
    ['/opt/atc/bin/atc'],
    ctx.stateDir,
    ctx.home,
  );

  expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ statusLine: { padding: 2 } });
});
