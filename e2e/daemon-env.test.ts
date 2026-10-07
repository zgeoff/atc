import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { $ } from 'bun';
import { getRecord } from '../src/shared/get-record';
import { createGitFixture } from '../src/test-utils/create-git-fixture';
import { createStubClaude } from '../src/test-utils/create-stub-claude';
import { createStubComposer } from '../src/test-utils/create-stub-composer';
import { getString } from '../src/test-utils/get-string';
import { resolveATCCommand } from '../src/test-utils/resolve-atc-command';
import { setupTempDir } from '../src/test-utils/setup-temp-dir';
import { startDaemonProcess } from '../src/test-utils/start-daemon-process';
import { waitFor } from '../src/test-utils/wait-for';

/**
 * A home with a stub Claude CLI and a config that offers it, for a test to
 * start a daemon on with the environment it is about.
 */
function setupTest() {
  const tmp = setupTempDir('atc-e2e-env-');
  const atc = resolveATCCommand();
  const claude = createStubClaude(tmp.dir, { atc, composer: createStubComposer(tmp.dir) });

  // The daemon spawns its sessions from the agents the config offers, and
  // clones a workspace from a local path only over the file transport.
  mkdirSync(join(tmp.dir, '.config', 'atc'), { recursive: true });

  writeFileSync(
    join(tmp.dir, '.config', 'atc', 'config.json'),
    JSON.stringify({
      agents: {
        claude: { bin: claude },
      },
      workspaces: { gitTransports: ['https', 'ssh', 'file'] },
    }),
  );

  return { home: tmp.dir, atc, [Symbol.dispose]: tmp[Symbol.dispose] };
}

test.each([
  { daemonTERM: undefined, sessionTERM: 'xterm-256color' },
  { daemonTERM: 'dumb', sessionTERM: 'xterm-256color' },
  { daemonTERM: 'screen-256color', sessionTERM: 'screen-256color' },
])(
  'it starts a session with TERM $sessionTERM when the daemon starts with TERM $daemonTERM',
  async (row) => {
    using ctx = setupTest();

    await using daemon = startDaemonProcess({
      command: ctx.atc,
      home: ctx.home,
      env: { TERM: row.daemonTERM },
    });

    const client = await daemon.openClient();

    await client.sendHello('atc/test');

    const ok = await client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

    const id = getString(getRecord(ok, 'session'), 'id');

    const screen = await waitFor(async () => {
      const read = await client.sendRequest('session.screen', { session: id });

      expect(read['text']).toMatch(/FAKE_CLAUDE_TERM:\[.*\]/);

      return read;
    });

    expect(screen['text']).toInclude(`FAKE_CLAUDE_TERM:[${row.sessionTERM}]`);
  },
);

test('it starts a session without a parent-session variable the daemon started with', async () => {
  using ctx = setupTest();

  await using daemon = startDaemonProcess({
    command: ctx.atc,
    home: ctx.home,
    env: { CLAUDE_CODE_ATC_TEST: 'synthetic' },
  });

  const client = await daemon.openClient();

  await client.sendHello('atc/test');

  const ok = await client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  const id = getString(getRecord(ok, 'session'), 'id');

  const screen = await waitFor(async () => {
    const read = await client.sendRequest('session.screen', { session: id });

    expect(read['text']).toMatch(/FAKE_CLAUDE_PARENT:\[.*\]/);

    return read;
  });

  expect(screen['text']).toInclude('FAKE_CLAUDE_PARENT:[unset]');
});

test('it unpacks every tracked file of a local workspace when the daemon env asks tar to exclude some', async () => {
  using ctx = setupTest();

  await using fixture = await createGitFixture({ prefix: 'atc-e2e-env-git-' });

  writeFileSync(join(fixture.work, 'notes.txt'), 'kept\n');

  await $`git add notes.txt`.env(fixture.env).cwd(fixture.work).quiet();
  await $`git commit --quiet -m notes`.env(fixture.env).cwd(fixture.work).quiet();
  await $`git push --quiet origin main`.env(fixture.env).cwd(fixture.work).quiet();

  // TAR_OPTIONS reaches tar only through the environment a process starts
  // with, so the daemon here starts with it set.
  await using daemon = startDaemonProcess({
    command: ctx.atc,
    home: ctx.home,
    env: { TAR_OPTIONS: '--exclude=*.txt' },
  });

  const client = await daemon.openClient();

  await client.sendHello('atc/test');

  await client.sendRequest('session.spawn', {
    cwd: join(ctx.home, 'ws'),
    workspace: { kind: 'git', url: fixture.upstream, ref: 'main' },
  });

  expect(readFileSync(join(ctx.home, 'ws', 'notes.txt'), 'utf8')).toBe('kept\n');
});
