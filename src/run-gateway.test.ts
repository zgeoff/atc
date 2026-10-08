import { expect, test } from 'bun:test';
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import invariant from 'tiny-invariant';
import { runGateway } from './run-gateway';
import { registerTestCleanup } from './test-utils/register-test-cleanup';
import { setupTempDir } from './test-utils/setup-temp-dir';

/**
 * A temp directory for the registry and the state directory. The directory
 * goes once the test finishes.
 */
function setupTest() {
  const tmp = setupTempDir('atc-run-gateway-');

  return { dir: tmp.dir };
}

test('it answers both probes for the host of its public URL', async () => {
  const ctx = setupTest();

  writeFileSync(
    join(ctx.dir, 'registry.json'),
    JSON.stringify({
      daemons: {
        cloud: { address: '127.0.0.1:9', daemonID: '0123abcd-0000-4000-8000-000000000000' },
      },
      defaultDaemon: 'cloud',
    }),
  );

  const printed: string[] = [];

  const signals = new Map<string, () => Promise<void>>();

  await runGateway(
    'atc-gateway/test',
    {
      host: '127.0.0.1',
      port: 0,
      publicURL: 'https://atc.geoff.cloud',
      registryPath: join(ctx.dir, 'registry.json'),
      stateDir: join(ctx.dir, 'state'),
    },
    {
      env: { ATC_GATEWAY_TOKEN_CLOUD: 'c'.repeat(32) },
      print: (line) => {
        printed.push(line);
      },
      printError: () => {},
      exit: () => {},
      registerSignal: (signal, listener) => {
        signals.set(signal, listener);
      },
    },
  );

  const stop = signals.get('SIGTERM');

  invariant(stop, 'the gateway registered no SIGTERM handler');
  registerTestCleanup(() => stop());

  const port = /listening on http:\/\/127\.0\.0\.1:(?<port>\d+)$/u.exec(printed.join('\n'))
    ?.groups?.['port'];

  invariant(port !== undefined, `no port in: ${printed.join('\n')}`);

  const health = await fetch(`http://127.0.0.1:${port}/healthz`, {
    headers: { host: 'atc.geoff.cloud' },
  });

  const ready = await fetch(`http://127.0.0.1:${port}/readyz`, {
    headers: { host: 'atc.geoff.cloud' },
  });

  expect(health.status).toBe(200);
  expect(ready.status).toBe(200);
});

test('it refuses a probe from a foreign host', async () => {
  const ctx = setupTest();

  writeFileSync(
    join(ctx.dir, 'registry.json'),
    JSON.stringify({
      daemons: {
        cloud: { address: '127.0.0.1:9', daemonID: '0123abcd-0000-4000-8000-000000000000' },
      },
      defaultDaemon: 'cloud',
    }),
  );

  const printed: string[] = [];

  const signals = new Map<string, () => Promise<void>>();

  await runGateway(
    'atc-gateway/test',
    {
      host: '127.0.0.1',
      port: 0,
      publicURL: 'https://atc.geoff.cloud',
      registryPath: join(ctx.dir, 'registry.json'),
      stateDir: join(ctx.dir, 'state'),
    },
    {
      env: { ATC_GATEWAY_TOKEN_CLOUD: 'c'.repeat(32) },
      print: (line) => {
        printed.push(line);
      },
      printError: () => {},
      exit: () => {},
      registerSignal: (signal, listener) => {
        signals.set(signal, listener);
      },
    },
  );

  const stop = signals.get('SIGTERM');

  invariant(stop, 'the gateway registered no SIGTERM handler');
  registerTestCleanup(() => stop());

  const port = /listening on http:\/\/127\.0\.0\.1:(?<port>\d+)$/u.exec(printed.join('\n'))
    ?.groups?.['port'];

  invariant(port !== undefined, `no port in: ${printed.join('\n')}`);

  const health = await fetch(`http://127.0.0.1:${port}/healthz`, {
    headers: { host: 'evil.example' },
  });

  expect(health.status).toBe(403);
});

test('it keeps both databases in the state directory and writes nowhere else', async () => {
  const ctx = setupTest();

  writeFileSync(
    join(ctx.dir, 'registry.json'),
    JSON.stringify({
      daemons: {
        cloud: { address: '127.0.0.1:9', daemonID: '0123abcd-0000-4000-8000-000000000000' },
      },
      defaultDaemon: 'cloud',
    }),
  );

  const signals = new Map<string, () => Promise<void>>();

  await runGateway(
    'atc-gateway/test',
    {
      host: '127.0.0.1',
      port: 0,
      publicURL: 'https://atc.geoff.cloud',
      registryPath: join(ctx.dir, 'registry.json'),
      stateDir: join(ctx.dir, 'state'),
    },
    {
      env: { ATC_GATEWAY_TOKEN_CLOUD: 'c'.repeat(32) },
      print: () => {},
      printError: () => {},
      exit: () => {},
      registerSignal: (signal, listener) => {
        signals.set(signal, listener);
      },
    },
  );

  const stop = signals.get('SIGTERM');

  invariant(stop, 'the gateway registered no SIGTERM handler');
  registerTestCleanup(() => stop());

  expect(readdirSync(join(ctx.dir, 'state'))).toIncludeAllMembers(['gateway.db', 'mcp-auth.db']);
  expect(readdirSync(ctx.dir).toSorted()).toStrictEqual(['registry.json', 'state']);
});

test('it exits 1 naming the token variable a daemon lacks', async () => {
  const ctx = setupTest();

  writeFileSync(
    join(ctx.dir, 'registry.json'),
    JSON.stringify({
      daemons: {
        cloud: { address: '127.0.0.1:9', daemonID: '0123abcd-0000-4000-8000-000000000000' },
      },
      defaultDaemon: 'cloud',
    }),
  );

  const errors: string[] = [];
  const exits: number[] = [];

  await runGateway(
    'atc-gateway/test',
    {
      host: '127.0.0.1',
      port: 0,
      publicURL: 'https://atc.geoff.cloud',
      registryPath: join(ctx.dir, 'registry.json'),
      stateDir: join(ctx.dir, 'state'),
    },
    {
      env: {},
      print: () => {},
      printError: (line) => {
        errors.push(line);
      },
      exit: (code) => {
        exits.push(code);
      },
      registerSignal: () => {},
    },
  );

  expect({ errors, exits }).toStrictEqual({
    errors: ["atc-gateway: daemon 'cloud' has no token: set ATC_GATEWAY_TOKEN_CLOUD"],
    exits: [1],
  });

  expect(readdirSync(ctx.dir)).toStrictEqual(['registry.json']);
});

test('it exits 1 on a registry that is not JSON', async () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.dir, 'bad.json'), 'not json');

  const errors: string[] = [];
  const exits: number[] = [];

  await runGateway(
    'atc-gateway/test',
    {
      host: '127.0.0.1',
      port: 0,
      publicURL: 'https://atc.geoff.cloud',
      registryPath: join(ctx.dir, 'bad.json'),
      stateDir: join(ctx.dir, 'state'),
    },
    {
      env: { ATC_GATEWAY_TOKEN_CLOUD: 'c'.repeat(32) },
      print: () => {},
      printError: (line) => {
        errors.push(line);
      },
      exit: (code) => {
        exits.push(code);
      },
      registerSignal: () => {},
    },
  );

  expect(exits).toStrictEqual([1]);
  expect(errors.join('\n')).toMatch(/^atc-gateway: cannot read the registry at .*bad\.json: .+$/u);
});

test('it stops serving and exits 0 on SIGTERM', async () => {
  const ctx = setupTest();

  writeFileSync(
    join(ctx.dir, 'registry.json'),
    JSON.stringify({
      daemons: {
        cloud: { address: '127.0.0.1:9', daemonID: '0123abcd-0000-4000-8000-000000000000' },
      },
      defaultDaemon: 'cloud',
    }),
  );

  const printed: string[] = [];
  const exits: number[] = [];

  const signals = new Map<string, () => Promise<void>>();

  await runGateway(
    'atc-gateway/test',
    {
      host: '127.0.0.1',
      port: 0,
      publicURL: 'https://atc.geoff.cloud',
      registryPath: join(ctx.dir, 'registry.json'),
      stateDir: join(ctx.dir, 'state'),
    },
    {
      env: { ATC_GATEWAY_TOKEN_CLOUD: 'c'.repeat(32) },
      print: (line) => {
        printed.push(line);
      },
      printError: () => {},
      exit: (code) => {
        exits.push(code);
      },
      registerSignal: (signal, listener) => {
        signals.set(signal, listener);
      },
    },
  );

  const handler = signals.get('SIGTERM');

  invariant(handler, 'the gateway registered no SIGTERM handler');

  const stop = registerTestCleanup(handler);

  const port = /listening on http:\/\/127\.0\.0\.1:(?<port>\d+)$/u.exec(printed.join('\n'))
    ?.groups?.['port'];

  invariant(port !== undefined, `no port in: ${printed.join('\n')}`);

  await stop();

  expect(exits).toStrictEqual([0]);

  expect(
    fetch(`http://127.0.0.1:${port}/healthz`, { headers: { host: 'atc.geoff.cloud' } }),
  ).rejects.toThrow();
});
