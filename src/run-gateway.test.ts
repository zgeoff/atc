import { expect, onTestFinished, test } from 'bun:test';
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import invariant from 'tiny-invariant';
import { runGateway } from './run-gateway';
import { setupTempDir } from './test-utils/setup-temp-dir';

// A temp directory for the registry and the state directory.
function setupTest() {
  return setupTempDir('atc-run-gateway-');
}

test('it answers both probes for the host of its public URL', async () => {
  using ctx = setupTest();

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
  onTestFinished(() => stop());

  const port = /listening on http:\/\/127\.0\.0\.1:(?<port>\d+)$/u.exec(printed.join('\n'))
    ?.groups?.['port'];

  invariant(port !== undefined, `no port in: ${printed.join('\n')}`);

  const health = await fetch(`http://127.0.0.1:${port}/healthz`, {
    headers: { host: 'atc.geoff.cloud' },
  });

  const ready = await fetch(`http://127.0.0.1:${port}/readyz`, {
    headers: { host: 'atc.geoff.cloud' },
  });

  expect([health.status, ready.status]).toStrictEqual([200, 200]);
});

test('it refuses a probe from a foreign host', async () => {
  using ctx = setupTest();

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
  onTestFinished(() => stop());

  const port = /listening on http:\/\/127\.0\.0\.1:(?<port>\d+)$/u.exec(printed.join('\n'))
    ?.groups?.['port'];

  invariant(port !== undefined, `no port in: ${printed.join('\n')}`);

  const health = await fetch(`http://127.0.0.1:${port}/healthz`, {
    headers: { host: 'evil.example' },
  });

  expect(health.status).toBe(403);
});

test('it keeps both databases in the state directory and writes nowhere else', async () => {
  using ctx = setupTest();

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
  onTestFinished(() => stop());

  expect({
    state: readdirSync(join(ctx.dir, 'state')),
    entries: readdirSync(ctx.dir).toSorted(),
  }).toStrictEqual({
    state: expect.toIncludeAllMembers(['gateway.db', 'mcp-auth.db']),
    entries: ['registry.json', 'state'],
  });
});

test('it exits 1 naming the token variable a daemon lacks', async () => {
  using ctx = setupTest();

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

  expect({ errors, exits, entries: readdirSync(ctx.dir) }).toStrictEqual({
    errors: ["atc-gateway: daemon 'cloud' has no token: set ATC_GATEWAY_TOKEN_CLOUD"],
    exits: [1],
    entries: ['registry.json'],
  });
});

test('it exits 1 on a registry that is not JSON', async () => {
  using ctx = setupTest();

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
  using ctx = setupTest();

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

  const stop = signals.get('SIGTERM');

  invariant(stop, 'the gateway registered no SIGTERM handler');

  const port = /listening on http:\/\/127\.0\.0\.1:(?<port>\d+)$/u.exec(printed.join('\n'))
    ?.groups?.['port'];

  invariant(port !== undefined, `no port in: ${printed.join('\n')}`);

  await stop();

  expect(exits).toStrictEqual([0]);

  expect(
    fetch(`http://127.0.0.1:${port}/healthz`, { headers: { host: 'atc.geoff.cloud' } }),
  ).rejects.toThrow();
});
