import { join } from 'node:path';
import { WringerError, createWringer, local } from '@wringer/core';
import type { DriverConfigContext, LaunchPlan, Wringer } from '@wringer/core';
import { db } from '@wringer/db';
import { http } from '@wringer/http';
import { mcp } from '@wringer/mcp';
import { stream } from '@wringer/stream';
import { terminal } from '@wringer/terminal';
import { z } from 'zod';
import { buildHomeCommand } from './build-home-command.ts';
import { buildHTTPMCPServer } from './build-http-mcp-server.ts';
import { checkDaemon } from './check-daemon.ts';
import { checkMCPDoor } from './check-mcp-door.ts';
import { checkMCPSignIn } from './check-mcp-sign-in.ts';
import { checkStubAgent } from './check-stub-agent.ts';
import { collectReadTools } from './collect-read-tools.ts';
import {
  localDigestEnv,
  localMCPClient,
  prodMCPClient,
  prodOriginEnv,
  prodReadTools,
  resourceMetadataPath,
} from './constants.ts';
import { createDockerSession } from './create-docker-session.ts';
import { createLocalMCPClient } from './create-local-mcp-client.ts';
import { createSession } from './create-session.ts';
import { parseDockerRunEndpoints } from './docker-run-endpoints.ts';
import { featurePaths, ignoredPaths, sharedPaths } from './feature-paths.ts';
import { readDockerSession } from './read-docker-session.ts';
import { readHandshakeRefusals } from './read-handshake-refusals.ts';
import { readSessionEvents } from './read-session-events.ts';
import { removeDockerSession } from './remove-docker-session.ts';
import { removeSession } from './remove-session.ts';
import { runCLICommand } from './run-cli-command.ts';
import { parseRunEndpoints } from './run-endpoints.ts';
import { stopSession } from './stop-session.ts';
import { wakeDockerSession } from './wake-docker-session.ts';

const sessionName = z.string().regex(/^wv-[a-z0-9-]+$/u, 'Name a verify session wv-<name>.');
const nameInput = z.strictObject({ name: sessionName });
const noInput = z.strictObject({});
const spawnedData = z.strictObject({ id: z.string(), name: z.string() });
const stoppedData = z.strictObject({ id: z.string() });
const forgottenData = z.strictObject({ forgotten: z.array(z.string()) });
const sessionEvent = z.strictObject({ ev: z.string(), state: z.string() });
const sessionEventsData = z.strictObject({ events: z.array(sessionEvent) });
const argvList = z.array(z.string()).min(1);
const cliRunArgs = z.strictObject({ argv: argvList });

const cliRunData = z.strictObject({
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
});

const refusal = z.strictObject({ peer: z.string(), reason: z.string() });
const refusalsData = z.strictObject({ refusals: z.array(refusal) });
const daemonData = z.strictObject({ socket: z.string() });
const stubData = z.strictObject({ bin: z.string() });
const doorData = z.strictObject({ resource: z.string() });

const dockerSessionData = z.strictObject({
  containers: z.array(z.string()),
  volumes: z.array(z.string()),
  tokenInEnv: z.boolean(),
  tokenSeenByHarness: z.boolean(),
});

const signInData = z.strictObject({ servers: z.record(z.string(), z.number().int()) });

const signInServers: Readonly<Record<string, readonly string[]>> = {
  local: ['remote', 'gateway'],
  prod: ['gateway'],
};

const repoRoot = join(import.meta.dir, '..', '..');
const cliEntry = join(repoRoot, 'packages', 'app', 'src', 'cli.ts');

// The registry's name is not `atc`: gunshi reads a command group named like the program as the
// program itself.
export function createVerifyRegistry(): Wringer {
  return (
    createWringer({ name: 'atc-verify' })
      .use(terminal({ cols: 120, rows: 30 }))
      .use(db({}))
      .use(stream({}))
      .use(http({}))
      .use(mcp({}))
      .target('local', {
        mode: 'launch',
        access: 'read-write',
        host: local(),
        launch: createLaunchPlan,
        drivers: {
          terminal: buildTerminalConfig,
          db: (ctx) => ({
            via: 'sql',
            adapter: 'sqlite',
            url: parseRunEndpoints(ctx.endpoints).db,
          }),
          stream: buildStreamConfig,

          http: () => ({ endpoint: 'remote', healthPath: '/healthz' }),
          mcp: buildLocalMCPConfig,
        },
      })
      .target('docker', {
        mode: 'launch',
        access: 'read-write',
        host: local(),
        launch: createDockerLaunchPlan,
        drivers: {
          db: (ctx) => ({
            via: 'sql',
            adapter: 'sqlite',
            url: parseDockerRunEndpoints(ctx.endpoints).db,
          }),
        },
      })
      .target('prod', {
        mode: 'attach',
        access: 'read-only',

        // a session's screen or name can hold anything, and a PR description is public
        evidence: 'local',
        refusalHint:
          'prod is the deployed atc gateway, and it is read-only. Leave the write undone, skip `done` for this feature, and report the write you needed.',
        host: local(),
        endpoints: readProdEndpoints,
        drivers: {
          // the gateway answers its own probes only for its public host
          http: () => ({ endpoint: 'mcp', healthPath: resourceMetadataPath }),
          mcp: (ctx) => ({
            servers: {
              gateway: buildHTTPMCPServer(parseOrigin(ctx, 'mcp'), prodMCPClient, prodReadTools),
            },
          }),
        },
      })
      .action({
        name: 'spawn-session',
        summary: 'Spawn a stand-in claude session with the name, in the run home, over the socket',
        effect: 'write',
        targets: ['local'],
        input: nameInput,
        data: spawnedData,
        run: (input, ctx) => createSession(ctx.endpoints, input.name),
      })
      .action({
        name: 'stop-session',
        summary: 'Kill the live session with the name, over the socket; it stays listed as exited',
        effect: 'write',
        targets: ['local'],
        input: nameInput,
        data: stoppedData,
        run: (input, ctx) => stopSession(ctx.endpoints, input.name),
      })
      .action({
        name: 'forget-session',
        summary:
          'Kill the session with the name if it runs, then forget it; a name no session has is a no-op',
        effect: 'write',
        targets: ['local'],
        input: nameInput,
        data: forgottenData,
        run: (input, ctx) => removeSession(ctx.endpoints, input.name),
      })
      .action({
        name: 'spawn-docker-session',
        summary: 'Spawn a stand-in claude session with the name on the docker target',
        effect: 'write',
        targets: ['docker'],
        input: nameInput,
        data: spawnedData,
        run: (input, ctx) => createDockerSession(ctx.endpoints, input.name),
      })
      .action({
        name: 'wake-docker-session',
        summary:
          'Kill the live docker session with the name, revive it, and wait until it is alive',
        effect: 'write',
        targets: ['docker'],
        input: nameInput,
        data: stoppedData,
        run: (input, ctx) => wakeDockerSession(ctx.endpoints, input.name),
      })
      .action({
        name: 'forget-docker-session',
        summary:
          'Kill the docker session with the name if it runs, then forget it with its confirm token',
        effect: 'write',
        targets: ['docker'],
        input: nameInput,
        data: forgottenData,
        run: (input, ctx) => removeDockerSession(ctx.endpoints, input.name),
      })
      .action({
        name: 'inspect-docker-session',
        summary:
          "Read the run's docker containers and volumes, whether any container's environment holds the token, and whether the harness read it",
        effect: 'read',
        targets: ['docker'],
        input: noInput,
        data: dockerSessionData,
        run: (_input, ctx) => readDockerSession(ctx.endpoints),
      })
      .command({
        path: ['session-events'],
        summary:
          'Check that `atc events` printed, since `use` marked the stream, the session added, a state change and its exit, in order',
        effect: 'read',
        args: nameInput,
        data: sessionEventsData,
        run: (args, ctx) => readSessionEvents(ctx.drivers.stream, args.name),
      })
      .command({
        path: ['cli', 'run'],
        summary:
          "Run the atc CLI of this checkout in the run's home with the arguments after `--`; it succeeds whatever the CLI exits with, and returns the exit code, stdout and stderr",
        effect: 'write',
        positionals: ['argv'],
        args: cliRunArgs,
        data: cliRunData,
        run: (args, ctx) => runCLICommand(ctx.exec, ctx.endpoints, cliEntry, args.argv),
      })
      .command({
        path: ['handshake-refusals'],
        summary:
          "Read the handshakes that the daemon's TCP listener refused since `use` marked the `daemon` stream; fails when it refused none",
        effect: 'read',
        args: noInput,
        data: refusalsData,
        run: (_args, ctx) => readHandshakeRefusals(ctx.drivers.stream),
      })
      .check({
        name: 'daemon',
        targets: ['local'],
        input: noInput,
        data: daemonData,
        timeoutMs: 10_000,
        run: (_input, ctx) => checkDaemon(ctx.endpoints),
      })
      .check({
        name: 'stub-agent',
        targets: ['local'],
        input: noInput,
        data: stubData,
        timeoutMs: 5000,
        run: (_input, ctx) => checkStubAgent(ctx.endpoints),
      })

      // on `local`, the remote-mcp-http journey checks the door of `atc mcp --http`
      .check({
        name: 'mcp-door',
        targets: ['prod'],
        input: noInput,
        data: doorData,
        timeoutMs: 10_000,
        run: (_input, ctx) => checkMCPDoor(ctx.drivers.http, parseOrigin(ctx, 'mcp')),
      })
      .check({
        name: 'mcp-sign-in',
        targets: ['local', 'prod'],
        input: noInput,
        data: signInData,
        timeoutMs: 20_000,
        run: (_input, ctx) => checkMCPSignIn(ctx.drivers.mcp, signInServers[ctx.target] ?? []),
      })
      .feature(
        {
          name: 'docker-target',
          summary: 'Run a session in docker containers, wake it after a kill, and forget it',
          paths: featurePaths['docker-target'],
        },
        {
          name: 'spawn-session',
          summary: 'Spawn a session from the TUI picker, and see it start',
          paths: featurePaths['spawn-session'],
        },
        {
          name: 'session-list-leader',
          summary: 'Open the session list with the leader key, ack a session, and filter the list',
          paths: featurePaths['session-list-leader'],
        },
        {
          name: 'kill-forget',
          summary: 'Kill a session from the session list, then forget it',
          paths: featurePaths['kill-forget'],
        },
        {
          name: 'events-stream',
          summary: 'Follow the fleet with `atc events` while a session starts and stops',
          paths: featurePaths['events-stream'],
        },
        {
          name: 'mcp-fleet-tools',
          summary: 'Spawn, type into, read and stop a session with the tools of `atc mcp`',
          paths: featurePaths['mcp-fleet-tools'],
        },
        {
          name: 'session-messages',
          summary: 'Send a session a message with `atc mcp`, see it reach the session, and read it',
          paths: featurePaths['session-messages'],
        },
        {
          name: 'cli-send',
          summary:
            'Send a session a message with `atc send`, then read and wait on it with `atc message get`',
          paths: featurePaths['cli-send'],
        },
        {
          name: 'remote-mcp-http',
          summary: 'Sign in to `atc mcp --http` as a service client, and list the sessions',
          paths: featurePaths['remote-mcp-http'],
        },
        {
          name: 'gateway-routing',
          summary:
            'Call a tool through atc-gateway, and see the daemon refuse a gateway with a wrong token',
          paths: featurePaths['gateway-routing'],
        },
      )
      .shared(...sharedPaths)
      .ignore(...ignoredPaths)
      .build()
  );
}

function createLaunchPlan(): LaunchPlan {
  return {
    command: [
      'bash',
      join(repoRoot, 'scripts', 'with-test-home.sh'),
      process.execPath,
      join(repoRoot, 'scripts', 'test-utils', 'run-local-daemon.ts'),
    ],

    // A Unix socket path holds at most 108 bytes, so the run's home goes under /tmp, whatever the caller's TMPDIR.
    env: { TMPDIR: '/tmp', [localDigestEnv]: createLocalMCPClient() },
    ready: (line) => (line['event'] === 'ready' ? parseRunEndpoints(line) : null),
  };
}

// The spawn picker lists the client's own folder first, so a session that a journey spawns runs in the run's home too.
function buildTerminalConfig(ctx: DriverConfigContext) {
  const run = parseRunEndpoints(ctx.endpoints);

  return {
    programs: {
      atc: { command: buildHomeCommand(run.root, [process.execPath, cliEntry]), cwd: run.home },
    },
  };
}

function buildStreamConfig(ctx: DriverConfigContext) {
  const run = parseRunEndpoints(ctx.endpoints);
  const events = buildHomeCommand(run.root, [process.execPath, cliEntry, 'events']);

  return { sources: { events: { command: events }, daemon: { file: run.daemonLog } } };
}

function buildLocalMCPConfig(ctx: DriverConfigContext) {
  const run = parseRunEndpoints(ctx.endpoints);
  const readTools = collectReadTools();

  return {
    servers: {
      atc: {
        transport: 'stdio' as const,
        command: buildHomeCommand(run.root, [process.execPath, cliEntry, 'mcp']),
        cwd: run.home,
        readTools,
      },
      remote: buildHTTPMCPServer(run.remote, localMCPClient, readTools),
      gateway: buildHTTPMCPServer(run.gateway, localMCPClient, readTools),
      'gateway-wrong': buildHTTPMCPServer(run.gatewayWrong, localMCPClient, readTools),
    },
  };
}

function createDockerLaunchPlan(): LaunchPlan {
  return {
    command: [
      'bash',
      join(repoRoot, 'scripts', 'with-test-home.sh'),
      process.execPath,
      join(repoRoot, 'scripts', 'test-utils', 'run-docker-daemon.ts'),
    ],
    env: { TMPDIR: '/tmp' },
    ready: (line) => (line['event'] === 'ready' ? parseDockerRunEndpoints(line) : null),
  };
}

// The supervisor reads the origin when `attach` starts the run, from the environment it took over.
function readProdEndpoints(): { mcp: string } {
  const origin = z.url().safeParse(process.env[prodOriginEnv]);

  if (!origin.success) {
    throw new WringerError('environment', {
      message: `prod needs the deployed gateway's origin in ${prodOriginEnv}`,
      hint: 'Set it on the `attach` line, as the On prod section of the gateway-routing feature file shows.',
    });
  }

  return { mcp: origin.data };
}

function parseOrigin(ctx: Pick<DriverConfigContext, 'endpoints'>, name: string): string {
  return z.url().parse(ctx.endpoints[name]);
}
