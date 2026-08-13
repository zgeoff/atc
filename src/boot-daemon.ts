import { spawn as spawnChild } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { daemonPidFile, daemonSocketPath } from './config';
import { DaemonClient } from './daemon-client';
import { getBuild } from './get-build';
import { isRecord } from './report';

export interface DaemonBoot {
  readonly client: DaemonClient;
  readonly stale: boolean;
}

/**
 * Opens a handshaken client to the daemon, booting the daemon first when its
 * socket is absent. A daemon from an older build stays in service — killing
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

    const client = await openOrBootDaemon();

    try {
      const hello = await client.sendHello(build);

      return { client, stale: hello['daemon'] !== build };
    } catch (error) {
      client.stop();

      if (attempt > 0 || !isProtocolMismatch(error)) {
        throw error;
      }

      await stopStaleDaemon();
    }
  }

  throw new Error('the atc daemon could not be restarted');
}

function isProtocolMismatch(error: unknown): boolean {
  return isRecord(error) && error['code'] === 'protocol_mismatch';
}

async function openOrBootDaemon(): Promise<DaemonClient> {
  let opened = await tryOpenDaemon();

  if (opened === null) {
    spawnDaemonDetached();

    const deadline = Date.now() + 5000;

    while (opened === null && Date.now() < deadline) {
      await Bun.sleep(100);

      opened = await tryOpenDaemon();
    }
  }

  if (opened === null) {
    throw new Error('the atc daemon did not come up; try `atc daemon` for its output');
  }

  return opened;
}

async function tryOpenDaemon(): Promise<DaemonClient | null> {
  try {
    return await DaemonClient.open(daemonSocketPath);
  } catch {
    return null;
  }
}

async function stopStaleDaemon(): Promise<void> {
  let pid = 0;

  try {
    pid = Number(readFileSync(daemonPidFile, 'utf8'));
  } catch {
    return;
  }

  if (!Number.isInteger(pid) || pid <= 1) {
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

function spawnDaemonDetached() {
  const exec = process.execPath;
  const isBun = basename(exec) === 'bun' || basename(exec) === 'bun.exe';
  const args = isBun ? [join(import.meta.dir, 'cli.ts'), 'daemon'] : ['daemon'];

  spawnChild(exec, args, { detached: true, stdio: 'ignore' }).unref();
}
