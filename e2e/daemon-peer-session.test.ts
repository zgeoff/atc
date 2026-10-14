import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startDaemonProcess } from '@atc/lifecycle/testing/start-daemon-process';
import { createStubBin } from '@atc/test-utils/create-stub-bin';
import { getRecord } from '@atc/test-utils/get-record';
import { getString } from '@atc/test-utils/get-string';
import { resolveATCCommand } from '@atc/test-utils/resolve-atc-command';
import { setupTempDir } from '@atc/test-utils/setup-temp-dir';
import { waitFor } from '@atc/test-utils/wait-for';

/**
 * A home with an empty config directory for the `atc daemon` each test
 * starts, the path of the probe a session's process runs, and the file the
 * probe writes its outcome to.
 */
function setupTest() {
  const tmp = setupTempDir('atc-e2e-peer-');
  const configDir = join(tmp.dir, '.config', 'atc');

  mkdirSync(configDir, { recursive: true });

  return {
    home: tmp.dir,
    atc: resolveATCCommand(),
    configPath: join(configDir, 'config.json'),
    probe: Bun.resolveSync('@atc/test-utils/run-stub-peer-probe', import.meta.dir),
    outPath: join(tmp.dir, 'probe.json'),
  };
}

test.skipIf(process.platform !== 'linux')(
  'it refuses a scope addition from a process inside the session that drops ATC_SESSION_ID',
  async () => {
    const ctx = setupTest();

    writeFileSync(
      ctx.configPath,
      JSON.stringify({ agents: { claude: { bin: join(ctx.home, 'probe-agent') } } }),
    );

    const daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

    // The session's harness waits for one input line, so the probe runs
    // only once the daemon holds the session, and runs as its grandchild.
    createStubBin(
      ctx.home,
      'probe-agent',
      `#!/usr/bin/env bash
read -r _
own="$ATC_SESSION_ID"
env -u ATC_SESSION_ID "${process.execPath}" "${ctx.probe}" scope-add "${daemon.socketPath}" "$own" "${ctx.outPath}"
exec cat
`,
    );

    const client = await daemon.openClient();

    await client.sendHello('atc/test');

    const spawned = await client.sendRequest('session.spawn', {
      cwd: ctx.home,
      cols: 80,
      rows: 24,
    });

    const id = getString(getRecord(spawned, 'session'), 'id');

    await client.sendRequest('session.input', { session: id, d: 'go\r' });

    const outcome = await waitFor(() => JSON.parse(readFileSync(ctx.outPath, 'utf8')) as unknown);

    expect(outcome).toStrictEqual({ code: 'unauthorized' });
  },
);

test.skipIf(process.platform !== 'linux')(
  'it records a message from a process inside the session that drops ATC_SESSION_ID as from that session',
  async () => {
    const ctx = setupTest();

    writeFileSync(
      ctx.configPath,
      JSON.stringify({ agents: { claude: { bin: join(ctx.home, 'probe-agent') } } }),
    );

    const daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

    createStubBin(
      ctx.home,
      'probe-agent',
      `#!/usr/bin/env bash
read -r _
own="$ATC_SESSION_ID"
env -u ATC_SESSION_ID "${process.execPath}" "${ctx.probe}" message "${daemon.socketPath}" "$own" "${ctx.outPath}"
exec cat
`,
    );

    const client = await daemon.openClient();

    await client.sendHello('atc/test');

    const spawned = await client.sendRequest('session.spawn', {
      cwd: ctx.home,
      cols: 80,
      rows: 24,
    });

    const id = getString(getRecord(spawned, 'session'), 'id');

    await client.sendRequest('session.input', { session: id, d: 'go\r' });

    const outcome = await waitFor(() => JSON.parse(readFileSync(ctx.outPath, 'utf8')) as unknown);

    const name = getString(getRecord(spawned, 'session'), 'name');

    expect(outcome).toStrictEqual({ from: name, sender: { kind: 'session', session: id, name } });
  },
);

test.skipIf(process.platform !== 'linux')(
  'it records a message from a process inside the session as from that session over the principal its request gives',
  async () => {
    const ctx = setupTest();

    writeFileSync(
      ctx.configPath,
      JSON.stringify({ agents: { claude: { bin: join(ctx.home, 'probe-agent') } } }),
    );

    const daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

    createStubBin(
      ctx.home,
      'probe-agent',
      `#!/usr/bin/env bash
read -r _
own="$ATC_SESSION_ID"
env -u ATC_SESSION_ID "${process.execPath}" "${ctx.probe}" message-as "${daemon.socketPath}" "$own" "${ctx.outPath}"
exec cat
`,
    );

    const client = await daemon.openClient();

    await client.sendHello('atc/test');

    const spawned = await client.sendRequest('session.spawn', {
      cwd: ctx.home,
      cols: 80,
      rows: 24,
    });

    const id = getString(getRecord(spawned, 'session'), 'id');
    const name = getString(getRecord(spawned, 'session'), 'name');

    await client.sendRequest('session.input', { session: id, d: 'go\r' });

    const outcome = await waitFor(() => JSON.parse(readFileSync(ctx.outPath, 'utf8')) as unknown);

    expect(outcome).toStrictEqual({ from: name, sender: { kind: 'session', session: id, name } });
  },
);

test.skipIf(process.platform !== 'linux')(
  'it refuses a handshake from a process inside a session that gives another session',
  async () => {
    const ctx = setupTest();

    writeFileSync(
      ctx.configPath,
      JSON.stringify({ agents: { claude: { bin: join(ctx.home, 'probe-agent') } } }),
    );

    const daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

    createStubBin(
      ctx.home,
      'probe-agent',
      `#!/usr/bin/env bash
read -r _
"${process.execPath}" "${ctx.probe}" hello "${daemon.socketPath}" "a-session-it-is-not-in" "${ctx.outPath}"
exec cat
`,
    );

    const client = await daemon.openClient();

    await client.sendHello('atc/test');

    const spawned = await client.sendRequest('session.spawn', {
      cwd: ctx.home,
      cols: 80,
      rows: 24,
    });

    const id = getString(getRecord(spawned, 'session'), 'id');

    await client.sendRequest('session.input', { session: id, d: 'go\r' });

    const outcome = await waitFor(() => JSON.parse(readFileSync(ctx.outPath, 'utf8')) as unknown);

    expect(outcome).toStrictEqual({ code: 'unauthorized' });
  },
);

test.skipIf(process.platform !== 'linux')(
  'it closes the events socket on a process inside a session before sending it anything',
  async () => {
    const ctx = setupTest();

    writeFileSync(
      ctx.configPath,
      JSON.stringify({ agents: { claude: { bin: join(ctx.home, 'probe-agent') } } }),
    );

    const daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

    // The daemon's runtime directory is the home, so its events socket sits
    // there.
    createStubBin(
      ctx.home,
      'probe-agent',
      `#!/usr/bin/env bash
read -r _
"${process.execPath}" "${ctx.probe}" events "${join(ctx.home, 'atc-events.sock')}" "$ATC_SESSION_ID" "${ctx.outPath}"
exec cat
`,
    );

    const client = await daemon.openClient();

    await client.sendHello('atc/test');

    const spawned = await client.sendRequest('session.spawn', {
      cwd: ctx.home,
      cols: 80,
      rows: 24,
    });

    const id = getString(getRecord(spawned, 'session'), 'id');

    await client.sendRequest('session.input', { session: id, d: 'go\r' });

    const outcome = await waitFor(() => JSON.parse(readFileSync(ctx.outPath, 'utf8')) as unknown);

    expect(outcome).toStrictEqual({ bytes: 0 });
  },
);

test.skipIf(process.platform === 'linux')(
  'it lets a process inside a session that drops ATC_SESSION_ID act as the owner where the kernel gives no peer pid',
  async () => {
    const ctx = setupTest();

    writeFileSync(
      ctx.configPath,
      JSON.stringify({ agents: { claude: { bin: join(ctx.home, 'probe-agent') } } }),
    );

    const daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

    createStubBin(
      ctx.home,
      'probe-agent',
      `#!/usr/bin/env bash
read -r _
own="$ATC_SESSION_ID"
env -u ATC_SESSION_ID "${process.execPath}" "${ctx.probe}" scope-add "${daemon.socketPath}" "$own" "${ctx.outPath}"
exec cat
`,
    );

    const client = await daemon.openClient();

    await client.sendHello('atc/test');

    const spawned = await client.sendRequest('session.spawn', {
      cwd: ctx.home,
      cols: 80,
      rows: 24,
    });

    const id = getString(getRecord(spawned, 'session'), 'id');

    await client.sendRequest('session.input', { session: id, d: 'go\r' });

    const outcome = await waitFor(() => JSON.parse(readFileSync(ctx.outPath, 'utf8')) as unknown);

    expect(outcome).toStrictEqual({ ok: true });
  },
);

test("it lets the owner's client outside every session add to a session's scope", async () => {
  const ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ agents: { claude: { bin: join(ctx.home, 'idle-agent') } } }),
  );

  createStubBin(ctx.home, 'idle-agent', '#!/usr/bin/env bash\nexec cat\n');

  const daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

  const client = await daemon.openClient();

  await client.sendHello('atc/test');

  const spawned = await client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  const id = getString(getRecord(spawned, 'session'), 'id');

  const added = await client.sendRequest('session.scope.add', { session: id, scope: {} });

  expect(getRecord(added, 'record')['session']).toBe(id);
});

test("it labels a message from the owner's client as the owner, whatever from it gives", async () => {
  const ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ agents: { claude: { bin: join(ctx.home, 'idle-agent') } } }),
  );

  createStubBin(ctx.home, 'idle-agent', '#!/usr/bin/env bash\nexec cat\n');

  const daemon = startDaemonProcess({ command: ctx.atc, home: ctx.home });

  const client = await daemon.openClient();

  await client.sendHello('atc/test');

  const spawned = await client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  const id = getString(getRecord(spawned, 'session'), 'id');

  const sent = await client.sendRequest('session.message', {
    session: id,
    text: 'is the build green?',
    from: 'release-bot',
  });

  const read = await client.sendRequest('message.get', { message: sent['message'] });

  expect([read['from'], read['sender']]).toStrictEqual(['owner', { kind: 'owner', name: 'owner' }]);
});
