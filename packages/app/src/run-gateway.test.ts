import { expect, test } from 'bun:test';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mintServiceSecret } from '@atc/mcp';
import { registerTestCleanup, setupTempDir } from '@atc/test-utils';
import invariant from 'tiny-invariant';
import { buildGatewayStatePaths } from './build-gateway-state-paths';
import { runGateway } from './run-gateway';
import { openTestAuthAdmin } from './test-utils/open-test-auth-admin';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-run-gateway-');

  return { directory: temporaryDirectory.path };
}

test('it answers the liveness probe for the host of its public URL', async () => {
  const ctx = setupTest();

  writeFileSync(
    join(ctx.directory, 'registry.json'),
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
      publicURL: 'https://atc.example.com',
      trustForwardedFrom: [],
      registryPath: join(ctx.directory, 'registry.json'),
      stateDir: join(ctx.directory, 'state'),
      serviceTokenFile: null,
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
    headers: { host: 'atc.example.com' },
  });

  expect(health.status).toBe(200);
});

test('it trusts the forwarded address from a proxy its flags list', async () => {
  const ctx = setupTest();

  writeFileSync(
    join(ctx.directory, 'registry.json'),
    JSON.stringify({
      daemons: {
        cloud: { address: '127.0.0.1:9', daemonID: '0123abcd-0000-4000-8000-000000000000' },
      },
      defaultDaemon: 'cloud',
    }),
  );

  const printed: string[] = [];
  const errors: string[] = [];

  const signals = new Map<string, () => Promise<void>>();

  await runGateway(
    'atc-gateway/test',
    {
      host: '127.0.0.1',
      port: 0,
      publicURL: 'https://atc.example.com',
      trustForwardedFrom: ['127.0.0.1'],
      registryPath: join(ctx.directory, 'registry.json'),
      stateDir: join(ctx.directory, 'state'),
      serviceTokenFile: null,
    },
    {
      env: { ATC_GATEWAY_TOKEN_CLOUD: 'c'.repeat(32) },
      print: (line) => {
        printed.push(line);
      },
      printError: (line) => {
        errors.push(line);
      },
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

  // A probe for a host the gateway does not serve writes a bad_host event.
  await fetch(`http://127.0.0.1:${port}/healthz`, {
    headers: { host: 'other.example', 'cf-connecting-ip': '198.51.100.23' },
  });

  expect(
    JSON.parse(
      `[${errors
        .filter((line) => line.startsWith('atc security '))
        .map((line) => line.slice('atc security '.length))
        .join(',')}]`,
    ),
  ).toMatchObject([
    {
      kind: 'bad_host',
      reason: 'host_not_allowed',
      forwarded: { address: '198.51.100.23', header: 'cf-connecting-ip', provenance: 'trusted' },
    },
  ]);
});

test('it leaves the forwarded address unverified from a peer its flags do not list', async () => {
  const ctx = setupTest();

  writeFileSync(
    join(ctx.directory, 'registry.json'),
    JSON.stringify({
      daemons: {
        cloud: { address: '127.0.0.1:9', daemonID: '0123abcd-0000-4000-8000-000000000000' },
      },
      defaultDaemon: 'cloud',
    }),
  );

  const printed: string[] = [];
  const errors: string[] = [];

  const signals = new Map<string, () => Promise<void>>();

  await runGateway(
    'atc-gateway/test',
    {
      host: '127.0.0.1',
      port: 0,
      publicURL: 'https://atc.example.com',
      trustForwardedFrom: ['192.0.2.1'],
      registryPath: join(ctx.directory, 'registry.json'),
      stateDir: join(ctx.directory, 'state'),
      serviceTokenFile: null,
    },
    {
      env: { ATC_GATEWAY_TOKEN_CLOUD: 'c'.repeat(32) },
      print: (line) => {
        printed.push(line);
      },
      printError: (line) => {
        errors.push(line);
      },
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

  // A probe for a host the gateway does not serve writes a bad_host event.
  await fetch(`http://127.0.0.1:${port}/healthz`, {
    headers: { host: 'other.example', 'cf-connecting-ip': '198.51.100.23' },
  });

  expect(
    JSON.parse(
      `[${errors
        .filter((line) => line.startsWith('atc security '))
        .map((line) => line.slice('atc security '.length))
        .join(',')}]`,
    ),
  ).toMatchObject([
    {
      kind: 'bad_host',
      reason: 'host_not_allowed',
      forwarded: {
        address: '198.51.100.23',
        header: 'cf-connecting-ip',
        provenance: 'unverified',
      },
    },
  ]);
});

test('it prints nothing to stdout once it serves and each sign-in security event to stderr', async () => {
  const ctx = setupTest();

  writeFileSync(
    join(ctx.directory, 'registry.json'),
    JSON.stringify({
      daemons: {
        cloud: { address: '127.0.0.1:9', daemonID: '0123abcd-0000-4000-8000-000000000000' },
      },
      defaultDaemon: 'cloud',
    }),
  );

  const printed: string[] = [];
  const errors: string[] = [];

  const signals = new Map<string, () => Promise<void>>();

  await runGateway(
    'atc-gateway/test',
    {
      host: '127.0.0.1',
      port: 0,
      publicURL: 'https://atc.example.com',
      trustForwardedFrom: [],
      registryPath: join(ctx.directory, 'registry.json'),
      stateDir: join(ctx.directory, 'state'),
      serviceTokenFile: null,
    },
    {
      env: { ATC_GATEWAY_TOKEN_CLOUD: 'c'.repeat(32) },
      print: (line) => {
        printed.push(line);
      },
      printError: (line) => {
        errors.push(line);
      },
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

  // The gateway's database, opened the way `atc-gateway clients` opens it.
  const store = await openTestAuthAdmin(
    buildGatewayStatePaths(join(ctx.directory, 'state')).mcpAuthDBFile,
  );

  const created = await store.admin.clients.add('Claude', [
    'https://claude.ai/api/mcp/auth_callback',
  ]);

  const startup = [...printed];

  const authorize = new URL(`http://127.0.0.1:${port}/oauth2/authorize`);

  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: created.clientID,
    redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    scope: 'read',
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    code_challenge_method: 'S256',
  }).toString();

  await fetch(authorize, { redirect: 'manual', headers: { host: 'atc.example.com' } });

  await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { host: 'rebound.example' },
  });

  expect(printed).toStrictEqual(startup);

  expect(errors.filter((line) => line.startsWith('atc security '))).toIncludeSameMembers([
    expect.stringMatching(
      /^atc security \{"version":1,.*"kind":"authorize_started","outcome":"accepted"/u,
    ),
    expect.stringMatching(
      /^atc security \{"version":1,.*"kind":"bad_host".*"reason":"host_not_allowed"/u,
    ),
  ]);
});

test('it writes a probe from a Host it does not serve as a bad_host security event', async () => {
  const ctx = setupTest();

  writeFileSync(
    join(ctx.directory, 'registry.json'),
    JSON.stringify({
      daemons: {
        cloud: { address: '127.0.0.1:9', daemonID: '0123abcd-0000-4000-8000-000000000000' },
      },
      defaultDaemon: 'cloud',
    }),
  );

  const printed: string[] = [];
  const errors: string[] = [];

  const signals = new Map<string, () => Promise<void>>();

  await runGateway(
    'atc-gateway/test',
    {
      host: '127.0.0.1',
      port: 0,
      publicURL: 'https://atc.example.com',
      trustForwardedFrom: [],
      registryPath: join(ctx.directory, 'registry.json'),
      stateDir: join(ctx.directory, 'state'),
      serviceTokenFile: null,
    },
    {
      env: { ATC_GATEWAY_TOKEN_CLOUD: 'c'.repeat(32) },
      print: (line) => {
        printed.push(line);
      },
      printError: (line) => {
        errors.push(line);
      },
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

  const refused = await fetch(`http://127.0.0.1:${port}/healthz`, {
    headers: { host: 'rebound.example' },
  });

  expect(refused.status).toBe(403);

  expect(errors.filter((line) => line.startsWith('atc security '))).toIncludeSameMembers([
    expect.stringMatching(
      /^atc security \{"version":1,.*"kind":"bad_host","outcome":"rejected","reason":"host_not_allowed","route":"\/healthz"/u,
    ),
  ]);
});

test('it answers the readiness probe for the host of its public URL', async () => {
  const ctx = setupTest();

  writeFileSync(
    join(ctx.directory, 'registry.json'),
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
      publicURL: 'https://atc.example.com',
      trustForwardedFrom: [],
      registryPath: join(ctx.directory, 'registry.json'),
      stateDir: join(ctx.directory, 'state'),
      serviceTokenFile: null,
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

  const ready = await fetch(`http://127.0.0.1:${port}/readyz`, {
    headers: { host: 'atc.example.com' },
  });

  expect(ready.status).toBe(200);
});

test('it refuses a probe from a foreign host', async () => {
  const ctx = setupTest();

  writeFileSync(
    join(ctx.directory, 'registry.json'),
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
      publicURL: 'https://atc.example.com',
      trustForwardedFrom: [],
      registryPath: join(ctx.directory, 'registry.json'),
      stateDir: join(ctx.directory, 'state'),
      serviceTokenFile: null,
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
    join(ctx.directory, 'registry.json'),
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
      publicURL: 'https://atc.example.com',
      trustForwardedFrom: [],
      registryPath: join(ctx.directory, 'registry.json'),
      stateDir: join(ctx.directory, 'state'),
      serviceTokenFile: null,
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

  const statePaths = buildGatewayStatePaths(join(ctx.directory, 'state'));

  expect([
    existsSync(statePaths.bindingsDBFile),
    existsSync(statePaths.mcpAuthDBFile),
  ]).toStrictEqual([true, true]);

  expect(readdirSync(ctx.directory).toSorted()).toStrictEqual(['registry.json', 'state']);
});

test('it exits 1 naming the token variable a daemon lacks', async () => {
  const ctx = setupTest();

  writeFileSync(
    join(ctx.directory, 'registry.json'),
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
      publicURL: 'https://atc.example.com',
      trustForwardedFrom: [],
      registryPath: join(ctx.directory, 'registry.json'),
      stateDir: join(ctx.directory, 'state'),
      serviceTokenFile: null,
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

  expect(readdirSync(ctx.directory)).toStrictEqual(['registry.json']);
});

test('it exits 1 on a registry that is not JSON', async () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.directory, 'bad.json'), 'not json');

  const errors: string[] = [];
  const exits: number[] = [];

  await runGateway(
    'atc-gateway/test',
    {
      host: '127.0.0.1',
      port: 0,
      publicURL: 'https://atc.example.com',
      trustForwardedFrom: [],
      registryPath: join(ctx.directory, 'bad.json'),
      stateDir: join(ctx.directory, 'state'),
      serviceTokenFile: null,
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

  const prefix = RegExp.escape(
    `atc-gateway: cannot read the registry at ${join(ctx.directory, 'bad.json')}: `,
  );

  expect(exits).toStrictEqual([1]);
  expect(errors.join('\n')).toMatch(new RegExp(`^${prefix}.+$`, 'u'));
});

test('it stops serving and exits 0 on SIGTERM', async () => {
  const ctx = setupTest();

  writeFileSync(
    join(ctx.directory, 'registry.json'),
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
      publicURL: 'https://atc.example.com',
      trustForwardedFrom: [],
      registryPath: join(ctx.directory, 'registry.json'),
      stateDir: join(ctx.directory, 'state'),
      serviceTokenFile: null,
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
    fetch(`http://127.0.0.1:${port}/healthz`, { headers: { host: 'atc.example.com' } }),
  ).rejects.toThrow();
});

test('it exits 1 naming the fault in a service token file and starts nothing', async () => {
  const ctx = setupTest();

  writeFileSync(
    join(ctx.directory, 'registry.json'),
    JSON.stringify({
      daemons: {
        cloud: { address: '127.0.0.1:9', daemonID: '0123abcd-0000-4000-8000-000000000000' },
      },
      defaultDaemon: 'cloud',
    }),
  );

  const tokenFile = join(ctx.directory, 'service-tokens.json');

  writeFileSync(
    tokenFile,
    JSON.stringify({
      resource: 'https://atc.example.com/mcp',
      clients: { ci: { scopes: ['read'], tokens: [`atcs_${'a'.repeat(31)}`] } },
    }),
    { mode: 0o600 },
  );

  const errors: string[] = [];
  const exits: number[] = [];

  await runGateway(
    'atc-gateway/test',
    {
      host: '127.0.0.1',
      port: 0,
      publicURL: 'https://atc.example.com',
      trustForwardedFrom: [],
      registryPath: join(ctx.directory, 'registry.json'),
      stateDir: join(ctx.directory, 'state'),
      serviceTokenFile: tokenFile,
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

  expect({ errors, exits, stateEntries: existsSync(join(ctx.directory, 'state')) }).toStrictEqual({
    errors: [
      `atc-gateway: --service-token-file: ${tokenFile}: clients.ci.tokens[0]: a token must be atcs_ followed by 32 or more of A-Z, a-z, 0-9, _ and -`,
    ],
    exits: [1],
    stateEntries: false,
  });
});

test('it exits 1 when the service token file is for another resource', async () => {
  const ctx = setupTest();

  writeFileSync(
    join(ctx.directory, 'registry.json'),
    JSON.stringify({
      daemons: {
        cloud: { address: '127.0.0.1:9', daemonID: '0123abcd-0000-4000-8000-000000000000' },
      },
      defaultDaemon: 'cloud',
    }),
  );

  const tokenFile = join(ctx.directory, 'service-tokens.json');

  writeFileSync(
    tokenFile,
    JSON.stringify({
      resource: 'https://other.example.com/mcp',
      clients: { ci: { scopes: ['read'], tokens: [`atcs_${'a'.repeat(32)}`] } },
    }),
    { mode: 0o600 },
  );

  const errors: string[] = [];
  const exits: number[] = [];

  await runGateway(
    'atc-gateway/test',
    {
      host: '127.0.0.1',
      port: 0,
      publicURL: 'https://atc.example.com',
      trustForwardedFrom: [],
      registryPath: join(ctx.directory, 'registry.json'),
      stateDir: join(ctx.directory, 'state'),
      serviceTokenFile: tokenFile,
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

  expect({ errors, exits }).toStrictEqual({
    errors: [
      'atc-gateway: the service token file names another resource than https://atc.example.com/mcp',
    ],
    exits: [1],
  });
});

test('it reads the service token file again on SIGHUP, and keeps the old one when the new one fails to load', async () => {
  const ctx = setupTest();
  const kept = mintServiceSecret();
  const added = mintServiceSecret();
  const tokenFile = join(ctx.directory, 'service-tokens.json');

  writeFileSync(
    join(ctx.directory, 'registry.json'),
    JSON.stringify({
      daemons: {
        cloud: { address: '127.0.0.1:9', daemonID: '0123abcd-0000-4000-8000-000000000000' },
      },
      defaultDaemon: 'cloud',
    }),
  );

  writeFileSync(
    tokenFile,
    JSON.stringify({
      resource: 'https://atc.example.com/mcp',
      clients: { 'ci-bot': { scopes: ['read'], secretDigests: [kept.digest] } },
    }),
    { mode: 0o600 },
  );

  const printed: string[] = [];
  const errors: string[] = [];

  const signals = new Map<string, () => Promise<void>>();

  await runGateway(
    'atc-gateway/test',
    {
      host: '127.0.0.1',
      port: 0,
      publicURL: 'https://atc.example.com',
      trustForwardedFrom: [],
      registryPath: join(ctx.directory, 'registry.json'),
      stateDir: join(ctx.directory, 'state'),
      serviceTokenFile: tokenFile,
    },
    {
      env: { ATC_GATEWAY_TOKEN_CLOUD: 'c'.repeat(32) },
      print: (line) => {
        printed.push(line);
      },
      printError: (line) => {
        errors.push(line);
      },
      exit: () => {},
      registerSignal: (signal, listener) => {
        signals.set(signal, listener);
      },
    },
  );

  const stop = signals.get('SIGTERM');
  const reload = signals.get('SIGHUP');

  invariant(stop, 'the gateway registered no SIGTERM handler');
  invariant(reload, 'the gateway registered no SIGHUP handler');
  registerTestCleanup(() => stop());

  const port = /listening on http:\/\/127\.0\.0\.1:(?<port>\d+)$/u.exec(printed.join('\n'))
    ?.groups?.['port'];

  invariant(port !== undefined, `no port in: ${printed.join('\n')}`);

  const requestToken = (name: string, secret: string) =>
    fetch(`http://127.0.0.1:${port}/oauth2/token`, {
      method: 'POST',
      headers: {
        host: 'atc.example.com',
        authorization: `Basic ${Buffer.from(`${encodeURIComponent(`service:${name}`)}:${secret}`).toString('base64')}`,
      },
      body: new URLSearchParams({ grant_type: 'client_credentials' }),
    });

  writeFileSync(tokenFile, '{ not json');

  await reload();

  const afterBadFile = await requestToken('ci-bot', kept.secret);

  writeFileSync(
    tokenFile,
    JSON.stringify({
      resource: 'https://atc.example.com/mcp',
      clients: { 'new-bot': { scopes: ['read'], secretDigests: [added.digest] } },
    }),
  );

  await reload();

  const droppedClient = await requestToken('ci-bot', kept.secret);
  const addedClient = await requestToken('new-bot', added.secret);

  expect({
    afterBadFile: afterBadFile.status,
    droppedClient: droppedClient.status,
    addedClient: addedClient.status,
    faults: errors.filter((line) => line.startsWith('atc-gateway: --service-token-file:')),
  }).toStrictEqual({
    afterBadFile: 200,
    droppedClient: 401,
    addedClient: 200,
    faults: [`atc-gateway: --service-token-file: ${tokenFile}: the file is not valid JSON`],
  });
});
