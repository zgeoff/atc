import { join } from 'node:path';
import { createWringer, local } from '@wringer/core';
import type { DriverConfigContext, LaunchPlan, Wringer } from '@wringer/core';
import { db } from '@wringer/db';
import { stream } from '@wringer/stream';
import { terminal } from '@wringer/terminal';
import { z } from 'zod';
import { buildHomeCommand } from './build-home-command.ts';
import { checkDaemon } from './check-daemon.ts';
import { checkStubAgent } from './check-stub-agent.ts';
import { createSession } from './create-session.ts';
import { featurePaths, ignoredPaths, sharedPaths } from './feature-paths.ts';
import { readSessionEvents } from './read-session-events.ts';
import { removeSession } from './remove-session.ts';
import { parseRunEndpoints } from './run-endpoints.ts';
import { stopSession } from './stop-session.ts';

const sessionName = z.string().regex(/^wv-[a-z0-9-]+$/u, 'Name a verify session wv-<name>.');
const nameInput = z.strictObject({ name: sessionName });
const noInput = z.strictObject({});
const spawnedData = z.strictObject({ id: z.string(), name: z.string() });
const stoppedData = z.strictObject({ id: z.string() });
const forgottenData = z.strictObject({ forgotten: z.array(z.string()) });
const sessionEvent = z.strictObject({ ev: z.string(), state: z.string() });
const sessionEventsData = z.strictObject({ events: z.array(sessionEvent) });
const daemonData = z.strictObject({ socket: z.string() });
const stubData = z.strictObject({ bin: z.string() });

// The registry's name is not `atc`: gunshi reads a command group named like the program as the
// program itself.
export function createVerifyRegistry(): Wringer {
  return createWringer({ name: 'atc-verify' })
    .use(terminal({ cols: 120, rows: 30 }))
    .use(db({}))
    .use(stream({}))
    .target('local', {
      mode: 'launch',
      access: 'read-write',
      host: local(),
      launch: buildLaunchPlan,
      drivers: {
        terminal: buildTerminalConfig,
        db: (ctx) => ({ via: 'sql', adapter: 'sqlite', url: parseRunEndpoints(ctx.endpoints).db }),
        stream: buildStreamConfig,
      },
    })
    .action({
      name: 'spawn-session',
      summary: 'Spawn a stand-in claude session with the name, in the run home, over the socket',
      effect: 'write',
      input: nameInput,
      data: spawnedData,
      run: (input, ctx) => createSession(ctx.endpoints, input.name),
    })
    .action({
      name: 'stop-session',
      summary: 'Kill the live session with the name, over the socket; it stays listed as exited',
      effect: 'write',
      input: nameInput,
      data: stoppedData,
      run: (input, ctx) => stopSession(ctx.endpoints, input.name),
    })
    .action({
      name: 'forget-session',
      summary:
        'Kill the session with the name if it runs, then forget it; a name no session has is a no-op',
      effect: 'write',
      input: nameInput,
      data: forgottenData,
      run: (input, ctx) => removeSession(ctx.endpoints, input.name),
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
    .check({
      name: 'daemon',
      input: noInput,
      data: daemonData,
      timeoutMs: 10_000,
      run: (_input, ctx) => checkDaemon(ctx.endpoints),
    })
    .check({
      name: 'stub-agent',
      input: noInput,
      data: stubData,
      timeoutMs: 5000,
      run: (_input, ctx) => checkStubAgent(ctx.endpoints),
    })
    .feature(
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
    )
    .shared(...sharedPaths)
    .ignore(...ignoredPaths)
    .build();
}

const repoRoot = join(import.meta.dir, '..', '..');

// with-test-home.sh makes the run's temp home, and removes it and every process the run started
// once the daemon's launcher exits.
function buildLaunchPlan(): LaunchPlan {
  return {
    command: [
      'bash',
      join(repoRoot, 'scripts', 'with-test-home.sh'),
      process.execPath,
      join(import.meta.dir, 'run-local-daemon.ts'),
    ],

    // A Unix socket path holds at most 108 bytes, so the run's home goes under /tmp, whatever the
    // caller's TMPDIR, which can be a long folder.
    env: { TMPDIR: '/tmp' },
    ready: (line) => (line['event'] === 'ready' ? parseRunEndpoints(line) : null),
  };
}

const cliEntry = join(repoRoot, 'packages', 'app', 'src', 'cli.ts');

// The one program the terminal driver starts: the TUI, in the run's home. The spawn picker lists
// the client's own folder first, so a session that a journey spawns runs in the run's home too.
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

  return { sources: { events: { command: events } } };
}
