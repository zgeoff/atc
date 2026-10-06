import { spawn as spawnChild } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DaemonError } from '../protocol/daemon-error';
import type { DaemonFeature } from '../protocol/daemon-features';
import { parseDaemonFeatures } from '../protocol/parse-daemon-features';
import { PROTOCOL_V } from '../protocol/protocol';
import type { AgentID } from '../shared/agent-id';
import { daemonPidFile, daemonRecordFile, daemonSocketPath } from '../shared/config';
import { findDaemonRecord } from '../shared/find-daemon-record';
import { getBuild } from '../shared/get-build';
import { isCompiledBinary } from '../shared/is-compiled-binary';
import { makeSingleFlight } from '../shared/make-single-flight';
import { toAgentID } from '../shared/to-agent-id';
import { DaemonClient } from './daemon-client';
import { formatProtocolMismatch } from './format-protocol-mismatch';
import type { ProtocolMismatch } from './format-protocol-mismatch';
import { pickStaleDaemonPID } from './pick-stale-daemon-pid';

export interface DaemonBoot {
  readonly client: DaemonClient;
  readonly stale: boolean;
  readonly lastUsedAgent: AgentID;

  // What the daemon announced it serves; an older daemon announces less.
  readonly features: ReadonlySet<DaemonFeature>;

  // The socket the client reached, which differs from the computed one when
  // the daemon was found through its record in the state directory.
  readonly socketPath: string;
}

export interface DaemonBootOptions {
  // Called when the daemon speaks another protocol version. Resolving true
  // stops that daemon and boots one from this build, which ends every
  // session it hosts; without the callback, or resolving false, the boot
  // rejects and the daemon keeps running.
  readonly onProtocolMismatch?: (mismatch: ProtocolMismatch) => Promise<boolean>;

  // When set, the boot never starts a daemon: it waits this many
  // milliseconds for one to answer, then rejects. A caller that a service
  // manager starts beside a managed daemon sets it, so the two never race
  // for the state directory.
  readonly waitForDaemonMs?: number;
}

/**
 * Opens a handshaken client to the daemon, booting the daemon first when
 * neither the computed socket nor the one in the daemon's record answers,
 * or waiting for one to answer when the caller set `waitForDaemonMs`.
 * Overlapping calls in one process share a single boot. A daemon from an
 * older build stays in service, since stopping it would end every hosted
 * session, and is reported as stale so the caller can offer a deliberate
 * restart. A daemon on another protocol version stays in service too: the
 * boot rejects with `protocol_mismatch` and a message holding both builds,
 * both versions, and the way to restart it, unless the caller's
 * `onProtocolMismatch` confirms a restart. The expected build is read from
 * disk on every attempt: a long-lived caller holding a build string from
 * its own boot would otherwise flag daemons that are already current.
 */
export async function bootDaemonClient(options: DaemonBootOptions = {}): Promise<DaemonBoot> {
  const wait =
    options.waitForDaemonMs === undefined
      ? null
      : { deadline: Date.now() + options.waitForDaemonMs, timeoutMs: options.waitForDaemonMs };

  for (let attempt = 0; attempt < 2; attempt++) {
    const build = getBuild();
    const opened = wait === null ? await openOrBootDaemon() : await waitForDaemon(wait);
    const client = opened.client;

    try {
      const hello =
        wait === null
          ? await client.sendHello(build)
          : await waitForHello(() => client.sendHello(build), wait);

      return {
        client,
        stale: hello['daemon'] !== build,
        lastUsedAgent: toAgentID(hello['lastUsedAgent']),
        features: parseDaemonFeatures(hello),
        socketPath: opened.socketPath,
      };
    } catch (error) {
      client.stop();

      if (attempt > 0 || !(error instanceof DaemonError) || error.code !== 'protocol_mismatch') {
        throw error;
      }

      const mismatch: ProtocolMismatch = {
        socketPath: opened.socketPath,
        daemonPID: findDaemonPID(opened.socketPath),
        clientBuild: build,
        clientProtocol: PROTOCOL_V,
        daemonMessage: error.message,
      };

      // Without a pid there is no daemon this client could stop, so the
      // caller is not asked.
      if (
        mismatch.daemonPID === null ||
        options.onProtocolMismatch === undefined ||
        !(await options.onProtocolMismatch(mismatch))
      ) {
        throw new DaemonError('protocol_mismatch', formatProtocolMismatch(mismatch));
      }

      await stopDaemon(mismatch.daemonPID);
    }
  }

  throw new Error('the atc daemon could not be restarted');
}

interface OpenedDaemon {
  readonly client: DaemonClient;
  readonly socketPath: string;
}

async function openOrBootDaemon(): Promise<OpenedDaemon> {
  const opened = await tryOpenKnownDaemon();

  if (opened !== null) {
    return opened;
  }

  await bootDaemonOnce();

  const booted = await tryOpenKnownDaemon();

  if (booted === null) {
    throw new Error(formatBootFailure());
  }

  return booted;
}

// The time a waiting boot gives up, and the length of its wait for the
// error text.
interface DaemonWait {
  readonly deadline: number;
  readonly timeoutMs: number;
}

/**
 * Polls the known sockets until a daemon answers, and never starts one.
 */
async function waitForDaemon(wait: DaemonWait): Promise<OpenedDaemon> {
  for (;;) {
    const opened = await tryOpenKnownDaemon();

    if (opened !== null) {
      return opened;
    }

    if (Date.now() >= wait.deadline) {
      throw new Error(formatWaitFailure(wait.timeoutMs));
    }

    await Bun.sleep(100);
  }
}

/**
 * Sends the handshake and rejects once the wait's deadline passes, so a
 * daemon that takes the connection but never answers cannot hold the wait
 * open.
 */
async function waitForHello(
  sendHello: () => Promise<Readonly<Record<string, unknown>>>,
  wait: DaemonWait,
): Promise<Readonly<Record<string, unknown>>> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => {
        reject(new Error(formatWaitFailure(wait.timeoutMs)));
      },
      Math.max(0, wait.deadline - Date.now()),
    );
  });

  try {
    return await Promise.race([sendHello(), expired]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Tries the socket this environment computes, then the one the running
 * daemon recorded in the state directory: a client whose environment lacks
 * XDG_RUNTIME_DIR computes a different path from the daemon's.
 */
async function tryOpenKnownDaemon(): Promise<OpenedDaemon | null> {
  const computed = await tryOpenDaemon(daemonSocketPath);

  if (computed !== null) {
    return computed;
  }

  const record = findDaemonRecord(daemonRecordFile);

  if (record === null || record.socketPath === daemonSocketPath) {
    return null;
  }

  return tryOpenDaemon(record.socketPath);
}

async function tryOpenDaemon(socketPath: string): Promise<OpenedDaemon | null> {
  try {
    return { client: await DaemonClient.open(socketPath), socketPath };
  } catch {
    return null;
  }
}

// How long a boot waits for a daemon to answer. It covers a daemon that
// waits out the state lock of one still shutting down.
const BOOT_DEADLINE_MS = 8000;

const bootDaemonOnce = makeSingleFlight(async () => {
  let child = spawnDaemonDetached();
  const deadline = Date.now() + BOOT_DEADLINE_MS;

  while (Date.now() < deadline) {
    await Bun.sleep(100);

    const probe = await tryOpenKnownDaemon();

    if (probe !== null) {
      probe.client.stop();

      return;
    }

    // A daemon that found the state lock still held by one shutting down
    // exits; once the old one is gone, a fresh spawn takes the lock.
    if (child.exitCode !== null || child.signalCode !== null) {
      child = spawnDaemonDetached();
    }
  }
});

// A live daemon this process cannot reach, such as one whose runtime
// directory a sandbox hides, needs a different fix than one that never
// started, so the message tells them apart.
function formatBootFailure(): string {
  return (
    formatUnreachableDaemon() ?? 'the atc daemon did not come up; try `atc daemon` for its output'
  );
}

function formatUnreachableDaemon(): string | null {
  const record = findDaemonRecord(daemonRecordFile);

  if (record !== null && isProcessAlive(record.pid)) {
    return `the atc daemon (pid ${record.pid}) is running, but its socket ${record.socketPath} is unreachable from here`;
  }

  return null;
}

// A waiting caller was told not to start a daemon, so the message says so
// and points at starting the managed one.
function formatWaitFailure(timeoutMs: number): string {
  return (
    formatUnreachableDaemon() ??
    `no atc daemon answered at ${daemonSocketPath} within ${timeoutMs / 1000}s, and this process does not start one; start \`atc daemon\` (or the service that runs it) first`
  );
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
}

// The pid of the daemon behind the socket that refused the handshake.
function findDaemonPID(socketPath: string): number | null {
  return pickStaleDaemonPID({
    socketPath,
    record: findDaemonRecord(daemonRecordFile),
    pidFileSocketPath: daemonSocketPath,
    pidFilePID: findPidFilePID(),
  });
}

async function stopDaemon(pid: number): Promise<void> {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return;
  }

  const deadline = Date.now() + 3000;

  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }

    await Bun.sleep(50);
  }
}

// The pid file beside the sockets this environment computes.
function findPidFilePID(): number | null {
  try {
    const pid = Number(readFileSync(daemonPidFile, 'utf8'));

    return Number.isInteger(pid) && pid > 1 ? pid : null;
  } catch {
    return null;
  }
}

function spawnDaemonDetached(): ChildProcess {
  const args = isCompiledBinary() ? ['daemon'] : [join(import.meta.dir, '..', 'cli.ts'), 'daemon'];
  const child = spawnChild(process.execPath, args, { detached: true, stdio: 'ignore' });

  child.unref();

  return child;
}
