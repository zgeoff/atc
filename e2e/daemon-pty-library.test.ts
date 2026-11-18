import { expect, test } from 'bun:test';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createStubComposer } from '@atc/app/test-utils/create-stub-composer';
import { getRecord } from '@atc/core/test-utils/get-record';
import { getString } from '@atc/core/test-utils/get-string';
import { resolveATCCommand } from '@atc/core/test-utils/resolve-atc-command';
import { setupTempDir } from '@atc/core/test-utils/setup-temp-dir';
import { waitFor } from '@atc/core/test-utils/wait-for';
import { createStubClaude } from '@atc/harness-claude/test-utils/create-stub-claude';
import { startDaemonProcess } from '@atc/lifecycle/test-utils/start-daemon-process';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-e2e-pty-library-');
  const atc = resolveATCCommand();
  const temporary = join(temporaryDirectory.path, 'tmp');

  mkdirSync(temporary);

  const homes = ['north', 'east', 'south', 'west'].map((name) => {
    const home = join(temporaryDirectory.path, name);
    const configDir = join(home, '.config', 'atc');

    mkdirSync(configDir, { recursive: true });

    return {
      home,
      configPath: join(configDir, 'config.json'),
      claude: createStubClaude(home, { atc, composer: createStubComposer(home) }),
    };
  });

  return { atc, temporary, homes };
}

test('it starts a session on each of four daemons that boot at once on one empty TMPDIR', async () => {
  const ctx = setupTest();

  for (const home of ctx.homes) {
    writeFileSync(home.configPath, JSON.stringify({ agents: { claude: { bin: home.claude } } }));
  }

  const daemons = ctx.homes.map((home) => ({
    home: home.home,
    process: startDaemonProcess({
      command: ctx.atc,
      home: home.home,
      env: { TMPDIR: ctx.temporary },
    }),
  }));

  const screens = await Promise.all(
    daemons.map(async (daemon) => {
      const client = await daemon.process.openClient();

      await client.sendHello('atc/test');

      const ok = await client.sendRequest('session.spawn', {
        cwd: daemon.home,
        cols: 80,
        rows: 24,
      });

      const id = getString(getRecord(ok, 'session'), 'id');

      return waitFor(async () => {
        const read = await client.sendRequest('session.screen', { session: id });

        expect(read['text']).toInclude('FAKE_CLAUDE_UP');

        return getString(read, 'text');
      });
    }),
  );

  // Bun names its own copy of an embedded library `.bun-<uid>-<hash>.<ext>`.
  expect({
    screens: screens.map((screen) => screen.includes('FAKE_CLAUDE_UP')),
    bunCopies: readdirSync(ctx.temporary).filter((name) => name.startsWith('.bun-')),
  }).toStrictEqual({ screens: [true, true, true, true], bunCopies: [] });
});
