import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startDaemonProcess } from '@atc/lifecycle/testing';
import {
  createStubBin,
  getRecord,
  getString,
  resolveATCCommand,
  setupTempDir,
  waitFor,
} from '@atc/test-utils';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-e2e-telemetry-');
  const configDir = join(temporaryDirectory.path, '.config', 'atc');

  mkdirSync(configDir, { recursive: true });

  return {
    home: temporaryDirectory.path,
    atc: resolveATCCommand(),
    configPath: join(configDir, 'config.json'),
    outPath: join(temporaryDirectory.path, 'attributes.txt'),
  };
}

test("it starts an agent with its session ID after the daemon's resource attributes", async () => {
  const ctx = setupTest();

  writeFileSync(
    ctx.configPath,
    JSON.stringify({ agents: { claude: { bin: join(ctx.home, 'probe-agent') } } }),
  );

  createStubBin(
    ctx.home,
    'probe-agent',
    `#!/usr/bin/env bash
printf '%s' "$OTEL_RESOURCE_ATTRIBUTES" > '${ctx.outPath}'
exec cat
`,
  );

  const daemon = startDaemonProcess({
    command: ctx.atc,
    home: ctx.home,
    env: { OTEL_RESOURCE_ATTRIBUTES: 'service.namespace=lab' },
  });

  const client = await daemon.openClient();

  await client.sendHello('atc/test');

  const spawned = await client.sendRequest('session.spawn', { cwd: ctx.home, cols: 80, rows: 24 });

  const id = getString(getRecord(spawned, 'session'), 'id');

  const attributes = await waitFor(() => {
    const text = readFileSync(ctx.outPath, 'utf8');

    expect(text).not.toBe('');

    return text;
  });

  expect(attributes).toBe(`service.namespace=lab,atc.session.id=${id}`);
});
