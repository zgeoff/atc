import { spawn as spawnChild } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { toAgentID } from '../agents/agent-adapter';
import type { AgentID } from '../agents/agent-adapter';
import type { DaemonFeature } from '../protocol/daemon-features';
import { parseDaemonFeatures } from '../protocol/parse-daemon-features';
import { daemonPidFile, daemonRecordFile, daemonSocketPath } from '../shared/config';
import { findDaemonRecord } from '../shared/find-daemon-record';
import { getBuild } from '../shared/get-build';
import { isCompiledBinary } from '../shared/is-compiled-binary';
import { makeSingleFlight } from '../shared/make-single-flight';
import { isRecord } from '../shared/report';
import { DaemonClient } from './daemon-client';
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

/**
 * Opens a handshaken client to the daemon, booting the daemon first when
 * neither the computed socket nor the one in the daemon's record answers.
 * Overlapping calls in one process share a single boot. A daemon from an older build stays in service — killing
 * it would kill every hosted session — and is reported as stale so the
 * caller can offer a deliberate restart. Only a protocol mismatch, where
 * talking would misbehave, forces the restart immediately. The expected
 * build is read from disk on every attempt: a long-lived caller holding a
 * build string from its own boot would otherwise flag daemons that are
 * already current.
 */
export async function bootDaemonClient(): Promise<DaemonBoot> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const build = getBuild();

    const opened = await openOrBootDaemon();

    const client = opened.client;

    try {
      const hello = await client.sendHello(build);

      return {
        client,
        stale: hello['daemon'] !== build,
        lastUsedAgent: toAgentID(hello['lastUsedAgent']),
        features: parseDaemonFeatures(hello),
        socketPath: opened.socketPath,
      };
    } catch (error) {
      client.stop();

      if (attempt > 0 || !isProtocolMismatch(error)) {
        throw error;
      }

      await stopStaleDaemon(opened.socketPath);
    }
  }

  throw new Error('the atc daemon could not be restarted');
}

function isProtocolMismatch(error: unknown): boolean {
  return isRecord(error) && error['code'] === 'protocol_mismatch';
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
  const record = findDaemonRecord(daemonRecordFile);

  if (record !== null && isProcessAlive(record.pid)) {
    return `the atc daemon (pid ${record.pid}) is running, but its socket ${record.socketPath} is unreachable from here`;
  }

  return 'the atc daemon did not come up; try `atc daemon` for its output';
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
}

async function stopStaleDaemon(socketPath: string): Promise<void> {
  const pid = pickStaleDaemonPID({
    socketPath,
    record: findDaemonRecord(daemonRecordFile),
    pidFileSocketPath: daemonSocketPath,
    pidFilePID: findPidFilePID(),
  });

  if (pid === null) {
    return;
  }

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
