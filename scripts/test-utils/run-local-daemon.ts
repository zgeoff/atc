import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildStubTUIClaude } from '@atc/app/test-utils/build-stub-tui-claude';
import { resolvePaths } from '@atc/config';
import { createStubBin } from '@atc/core/test-utils/create-stub-bin';
import { waitFor } from '@atc/core/test-utils/wait-for';
import type { Subprocess } from 'bun';
import { buildGatewayRegistry } from '../verify/build-gateway-registry.ts';
import { buildLocalConfig } from '../verify/build-local-config.ts';
import { buildServiceTokenFile } from '../verify/build-service-token-file.ts';
import { gatewayDaemonName, localDigestEnv } from '../verify/constants.ts';
import { openDaemonConnection } from '../verify/open-daemon-connection.ts';
import { readFreePort } from '../verify/read-free-port.ts';
import { readListenPort } from '../verify/read-listen-port.ts';
import { readRunHome } from '../verify/read-run-home.ts';
import type { RunHome } from '../verify/read-run-home.ts';
import { runListeningServer } from '../verify/run-listening-server.ts';

type Env = Readonly<Record<string, string | undefined>>;

export async function runLocalDaemon(env: Env) {
  const home = readRunHome(env);
  const paths = resolvePaths(env);
  const digest = readDigest(env);
  const stub = createStubBin(home.home, 'fake-claude', buildStubTUIClaude(home.cli));

  mkdirSync(join(home.home, '.config', 'atc'), { recursive: true });
  writeFileSync(paths.configFile, JSON.stringify(buildLocalConfig(home.home, stub)));
  writeFileSync(join(home.home, 'fake-claude-tap'), '');

  const daemonToken = randomBytes(32).toString('base64url');
  const tokenFile = writeOwnerOnlyFile(join(home.root, 'daemon-token'), `${daemonToken}\n`);
  const daemonLog = join(home.root, 'daemon.log');

  // The daemon's stderr goes to a file because the listener logs each refused handshake there.
  const daemon = Bun.spawn(
    [process.execPath, home.cli, 'daemon', '--listen', '127.0.0.1:0', '--token-file', tokenFile],
    { env: { ...env }, stdout: 'inherit', stderr: Bun.file(daemonLog) },
  );

  const servers: Subprocess[] = [daemon];

  const stopServers = () => {
    for (const server of servers) {
      server.kill('SIGTERM');
    }
  };

  process.on('SIGTERM', stopServers);
  process.on('SIGINT', stopServers);

  const answered = await waitFor(() => openDaemonConnection(paths.daemonSocketPath), {
    timeoutMs: 30_000,
    intervalMs: 100,
  });

  answered[Symbol.dispose]();

  const listenPort = await readListenPort(paths.daemonRecordFile);
  const daemonID = await readDaemonID(home, env);

  const registry = writeOwnerOnlyFile(
    join(home.root, 'gateway-registry.json'),
    JSON.stringify(buildGatewayRegistry(listenPort, daemonID)),
  );

  const remote = await startRemoteMCP(home, env, digest);
  const gateway = await startGateway(home, env, { name: 'gateway', registry, digest, daemonToken });

  const gatewayWrong = await startGateway(home, env, {
    name: 'gateway-wrong',
    registry,
    digest,
    daemonToken: randomBytes(32).toString('base64url'),
  });

  servers.push(remote.server, gateway.server, gatewayWrong.server);

  process.stdout.write(
    `${JSON.stringify({
      event: 'ready',
      root: home.root,
      home: home.home,
      stub,
      config: paths.configFile,
      socket: paths.daemonSocketPath,
      events: paths.eventsSocketPath,
      db: paths.dbFile,
      daemonLog,
      remote: remote.origin,
      gateway: gateway.origin,
      gatewayWrong: gatewayWrong.origin,
    })}\n`,
  );

  process.exitCode = await daemon.exited;
}

function readDigest(env: Env): string {
  const digest = env[localDigestEnv];

  if (digest === undefined || digest === '') {
    throw new Error(`${localDigestEnv} is unset: \`bun verify up\` sets it`);
  }

  return digest;
}

// atc refuses a token file that its group or any other user can open.
function writeOwnerOnlyFile(path: string, text: string): string {
  writeFileSync(path, text, { mode: 0o600 });

  return path;
}

async function readDaemonID(home: RunHome, env: Env): Promise<string> {
  const printed = Bun.spawn([process.execPath, home.cli, 'daemon', 'id'], {
    env: { ...env },
    stdout: 'pipe',
    stderr: 'inherit',
  });

  const [text, exitCode] = await Promise.all([new Response(printed.stdout).text(), printed.exited]);

  if (exitCode !== 0) {
    throw new Error(`atc daemon id exited ${String(exitCode)}`);
  }

  return text.trim();
}

interface StartedServer {
  readonly origin: string;
  readonly server: Subprocess;
}

async function startRemoteMCP(home: RunHome, env: Env, digest: string): Promise<StartedServer> {
  const port = await readFreePort();

  const origin = `http://127.0.0.1:${String(port)}`;

  const serviceTokens = writeOwnerOnlyFile(
    join(home.root, 'remote-service-tokens.json'),
    JSON.stringify(buildServiceTokenFile(origin, digest)),
  );

  const server = await runListeningServer(
    [
      process.execPath,
      home.cli,
      'mcp',
      '--http',
      '--port',
      String(port),
      '--public-url',
      origin,
      '--service-token-file',
      serviceTokens,
    ],
    env,
  );

  return { origin, server };
}

interface GatewayStart {
  readonly name: string;
  readonly registry: string;
  readonly digest: string;

  readonly daemonToken: string;
}

async function startGateway(home: RunHome, env: Env, start: GatewayStart): Promise<StartedServer> {
  const port = await readFreePort();

  const origin = `http://127.0.0.1:${String(port)}`;

  const serviceTokens = writeOwnerOnlyFile(
    join(home.root, `${start.name}-service-tokens.json`),
    JSON.stringify(buildServiceTokenFile(origin, start.digest)),
  );

  const server = await runListeningServer(
    [
      process.execPath,
      home.gateway,
      '--state-dir',
      join(home.root, start.name),
      'serve',
      '--port',
      String(port),
      '--public-url',
      origin,
      '--registry',
      start.registry,
      '--service-token-file',
      serviceTokens,
    ],
    { ...env, [`ATC_GATEWAY_TOKEN_${gatewayDaemonName.toUpperCase()}`]: start.daemonToken },
  );

  return { origin, server };
}

if (import.meta.main) {
  await runLocalDaemon(process.env);
}
