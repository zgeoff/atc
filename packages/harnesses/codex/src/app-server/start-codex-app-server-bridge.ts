import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectCleanEnv } from '@atc/config';
import type { MessageBridge, MessageBridgeRequest, SpawnPlan } from '@atc/plugin-api';
import type { Subprocess } from 'bun';
import { AppServerBridge } from './app-server-bridge';
import { AppServerConnection } from './app-server-connection';
import { AppServerError } from './app-server-error';

/**
 * How a session's App Server starts: the Codex binary, the terminal plan
 * for the server's address and the thread, how long a new server gets to
 * listen, how long a stopping one gets to exit before it is killed, and the
 * waits between reconnect attempts.
 */
export interface CodexAppServerLaunch {
  readonly bin: string;
  readonly planTerminal: (remote: string, thread: string) => SpawnPlan;
  readonly listenTimeoutMs?: number;
  readonly stopGraceMs?: number;
  readonly retryMs?: { readonly first: number; readonly max: number };
}

// How often a new server is tried while it comes up.
const LISTEN_POLL_MS = 50;

// How long a stopping server gets to exit before it is killed, unless the
// launch sets its own.
const STOP_GRACE_MS = 5000;

/**
 * Starts the session's own Codex App Server on a Unix socket in the
 * session's folder, with the session's environment, so the hooks and tools
 * the server runs report as the session. Then it opens the bridge and the
 * thread, and returns the plan that starts the terminal on that thread.
 * A server that exits is started again on the bridge's next connection,
 * and the terminal rejoins it by itself. A server an earlier daemon left
 * running on the socket is ended first. The stop ends the bridge, then the
 * server, and removes the socket. A start that fails stops what it started
 * before it rejects.
 */
export async function startCodexAppServerBridge(
  request: MessageBridgeRequest,
  launch: CodexAppServerLaunch,
): Promise<MessageBridge> {
  mkdirSync(request.dir, { recursive: true, mode: 0o700 });

  const socket = join(request.dir, 'codex.sock');
  const pidFile = join(request.dir, 'app-server.pid');
  const env = collectCleanEnv(request.env, request.withheldEnv);
  const bin = Bun.which(launch.bin, { PATH: env['PATH'] ?? '', cwd: request.cwd }) ?? launch.bin;
  const listenArgs = ['app-server', '--listen', `unix://${socket}`];
  const attempts = Math.ceil((launch.listenTimeoutMs ?? 10_000) / LISTEN_POLL_MS);
  let server: Subprocess | null = null;
  let stopped = false;

  await killOrphanedServer(pidFile, listenArgs.join(' '), launch.stopGraceMs ?? STOP_GRACE_MS);

  // Starts the server when none runs, then waits for it to listen.
  const openConnection = async (): Promise<AppServerConnection> => {
    if (stopped) {
      throw new AppServerError(-1, 'the bridge stopped');
    }

    if (server === null || server.exitCode !== null || server.signalCode !== null) {
      rmSync(socket, { force: true });

      server = Bun.spawn([bin, ...listenArgs], {
        cwd: request.cwd,
        env,
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: Bun.file(join(request.dir, 'app-server.log')),
      });

      writeFileSync(pidFile, String(server.pid));
    }

    const running = server;

    for (let attempt = 1; ; attempt += 1) {
      try {
        return await AppServerConnection.open(`ws+unix://${socket}`);
      } catch (error) {
        if (running.exitCode !== null || running.signalCode !== null || attempt >= attempts) {
          throw error;
        }

        await Bun.sleep(LISTEN_POLL_MS);
      }
    }
  };

  const resumeThread = typeof request.options.resume === 'string' ? request.options.resume : null;

  const bridge = new AppServerBridge({
    session: request.session,
    cwd: request.cwd,
    host: request.host,
    openConnection,
    resumeThread,
    ...(launch.retryMs === undefined ? {} : { retryMs: launch.retryMs }),
  });

  const stop = async () => {
    stopped = true;

    bridge.stop();

    const running = server;

    server = null;

    if (running !== null) {
      running.kill();

      // A server that ignores the stop signal is killed outright, so a
      // session's end and the daemon's stop never wait on it.
      const exited = await Promise.race([
        running.exited,
        Bun.sleep(launch.stopGraceMs ?? STOP_GRACE_MS),
      ]);

      if (exited === undefined) {
        running.kill('SIGKILL');

        await running.exited;
      }
    }

    rmSync(socket, { force: true });
    rmSync(pidFile, { force: true });
  };

  let thread: string;

  try {
    thread = await bridge.open();
  } catch (error) {
    await stop();

    throw error;
  }

  return {
    plan: launch.planTerminal(`unix://${socket}`, thread),
    startDelivery: () => {
      bridge.startDelivery();
    },
    updateThread: (next) => {
      bridge.updateThread(next);
    },
    stop,
  };
}

// Ends the server an earlier daemon started for this session and never
// stopped, as after a crash. The pid counts only while its process still
// runs this session's server command, so a pid the system gave to another
// process since is left alone. A server that ignores the stop signal for
// the grace period is killed outright, and one that outlives that too
// fails the start, so no second server runs beside one atc lost track of.
async function killOrphanedServer(
  pidFile: string,
  command: string,
  graceMs: number,
): Promise<void> {
  if (!existsSync(pidFile)) {
    return;
  }

  const pid = Number(readFileSync(pidFile, 'utf8').trim());

  if (Number.isInteger(pid) && pid > 0) {
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      const args = await readProcessArgs(pid);

      if (!args.includes(command)) {
        break;
      }

      try {
        process.kill(pid, signal);
      } catch {
        break;
      }

      const exited = await waitForExit(pid, graceMs);

      if (exited) {
        break;
      }

      if (signal === 'SIGKILL') {
        throw new AppServerError(
          -1,
          `the App Server ${pid} an earlier daemon left running for this session did not exit`,
        );
      }
    }
  }

  rmSync(pidFile, { force: true });
}

// The command line a process runs, or an empty string once it is gone.
function readProcessArgs(pid: number): Promise<string> {
  const ps = Bun.spawn(['ps', '-o', 'args=', '-p', String(pid)], { stderr: 'ignore' });

  return new Response(ps.stdout).text();
}

// Resolves true once the process is gone, or false when it still runs
// after the wait. Signal 0 checks that it exists without touching it.
async function waitForExit(pid: number, waitMs: number): Promise<boolean> {
  const attempts = Math.ceil(waitMs / LISTEN_POLL_MS);

  for (let attempt = 0; ; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }

    if (attempt >= attempts) {
      return false;
    }

    await Bun.sleep(LISTEN_POLL_MS);
  }
}
