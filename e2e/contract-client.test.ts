import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { startDaemonProcess } from '@atc/lifecycle/testing';
import { resolveATCCommand, runCommand, setupTempDir } from '@atc/test-utils';
import { PROTOCOL_VERSION } from '@atcx/contract/light';
import { z } from 'zod';

// A folder that installs the packed @atcx/contract as a consumer outside the
// repo does, with each dependency the packed manifest names linked to the
// copy the workspace installed for the contract, so no test reaches npm.
async function setupTest() {
  const root = join(import.meta.dir, '..');
  const work = setupTempDir('atc-contract-client-');
  const home = setupTempDir('atc-contract-client-home-');
  const consumer = join(work.path, 'consumer');
  const installed = join(consumer, 'node_modules/@atcx/contract');

  const packed = await runCommand(
    [process.execPath, join(root, 'scripts/pack-contract.ts'), '--out', work.path],
    { cwd: root },
  );

  mkdirSync(installed, { recursive: true });

  await runCommand(['tar', '-xzf', packed.stdout.trim(), '-C', installed, '--strip-components=1']);

  const manifestText = readFileSync(join(installed, 'package.json'), 'utf8');

  const manifest = z
    .object({ dependencies: z.record(z.string(), z.string()) })
    .parse(JSON.parse(manifestText));

  for (const name of Object.keys(manifest.dependencies)) {
    const link = join(consumer, 'node_modules', name);

    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(join(root, 'packages/contract/node_modules', name), link);
  }

  writeFileSync(join(consumer, 'package.json'), '{ "type": "module" }\n');

  const daemon = startDaemonProcess({ command: resolveATCCommand(), home: home.path });

  await daemon.openClient();

  return { consumer, home: home.path };
}

test('it answers a typed session list to a client from the packed contract over the daemon socket', async () => {
  const ctx = await setupTest();

  writeFileSync(
    join(ctx.consumer, 'call.ts'),
    `import { openDaemonClient, PROTOCOL_VERSION } from '@atcx/contract/client';
import { resolveAtcPaths } from '@atcx/contract/light';

const home = process.argv[2];
const client = await openDaemonClient(resolveAtcPaths({ HOME: home, XDG_RUNTIME_DIR: home }).daemonSocketPath);

try {
  await client.sendHello('example-watcher/2.3.0');

  const listing = await client.procedures.session.list({});

  console.log(JSON.stringify({ protocol: PROTOCOL_VERSION, sessions: listing.sessions }));
} finally {
  client.stop();
}
`,
  );

  const called = await runCommand([process.execPath, 'call.ts', ctx.home], { cwd: ctx.consumer });

  expect({ exitCode: called.exitCode, stderr: called.stderr }).toStrictEqual({
    exitCode: 0,
    stderr: '',
  });

  const printed: unknown = JSON.parse(called.stdout);
  const answerSchema = z.object({ protocol: z.number(), sessions: z.array(z.unknown()) });

  expect(answerSchema.parse(printed)).toStrictEqual({ protocol: PROTOCOL_VERSION, sessions: [] });
});
