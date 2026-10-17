import { expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { toAgentID } from '@atc/core';
import { setupTempDir } from '@atc/test-utils';
import { ClaudeLaunchFiles } from './claude-launch-files';

// The folders the files go to: a state folder, a home, and a mod folder,
// none of which exists until the files write it.
function setupTest() {
  const tmp = setupTempDir('atc-claude-launch-files-');

  return {
    stateDir: join(tmp.dir, 'state'),
    homeDir: join(tmp.dir, 'home'),
    bridgeTarget: join(tmp.dir, 'atc-bridge'),
  };
}

test('it writes nothing until a launch asks for a file', () => {
  const ctx = setupTest();

  void new ClaudeLaunchFiles({ id: toAgentID('claude') }, ['/opt/atc/bin/atc'], ctx);
  expect(existsSync(ctx.stateDir)).toBeFalse();
});

test("it writes the agent's settings file into the state folder", () => {
  const ctx = setupTest();

  const files = new ClaudeLaunchFiles({ id: toAgentID('claude') }, ['/opt/atc/bin/atc'], ctx);

  const settings = files.writeSettings();

  expect(settings).toBe(join(ctx.stateDir, 'hook-settings-claude.json'));

  expect(JSON.parse(readFileSync(settings, 'utf8'))).toMatchObject({
    statusLine: { command: '"/opt/atc/bin/atc" statusline --agent=\'claude\'' },
  });
});

test('it writes the settings file once and reuses it for every later launch', () => {
  const ctx = setupTest();

  const files = new ClaudeLaunchFiles({ id: toAgentID('claude') }, ['/opt/atc/bin/atc'], ctx);

  const settings = files.writeSettings();

  writeFileSync(settings, 'kept');

  const again = files.writeSettings();

  expect(again).toBe(settings);
  expect(readFileSync(settings, 'utf8')).toBe('kept');
});

test('it writes the mod into the mod folder, running the atc it is given', () => {
  const ctx = setupTest();

  const files = new ClaudeLaunchFiles({ id: toAgentID('claude') }, ['/opt/atc/bin/atc'], ctx);

  const bridge = files.writeBridge();

  expect(bridge).toBe(ctx.bridgeTarget);

  expect(readFileSync(join(bridge, 'hooks', 'atc-cli.ts'), 'utf8')).toBe(
    'export const ATC_CLI: readonly string[] = ["/opt/atc/bin/atc"];\n',
  );
});
