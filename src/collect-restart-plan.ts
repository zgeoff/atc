import { DaemonClient } from './client/daemon-client';
import { pickStaleDaemonPID } from './client/pick-stale-daemon-pid';
import { findRestartUnit } from './find-restart-unit';
import { DaemonError } from './protocol/daemon-error';
import { PROTOCOL_V } from './protocol/protocol';
import type { DaemonAnswer, PlanSession, ReplacementPlan, RestartPlan } from './restart-plan';
import { runSystemctl } from './run-systemctl';
import { buildATCCommand } from './shared/build-atc-command';
import { daemonPidFile, daemonRecordFile, daemonSocketPath } from './shared/config';
import { findDaemonRecord } from './shared/find-daemon-record';
import { findPidFilePID } from './shared/find-pid-file-pid';
import { getBuild } from './shared/get-build';
import { isProcessAlive } from './shared/is-process-alive';
import { isRecord } from './shared/report';

interface Probe {
  readonly socketPath: string;
  readonly answer: DaemonAnswer;
  readonly sessions: readonly PlanSession[] | null;
}

/**
 * Finds the daemon a restart would stop and the replacement it would start,
 * without changing either. The daemon answers on the socket this
 * environment computes or the one its record in the state directory holds,
 * and a handshake that its protocol refuses still identifies it.
 */
export async function collectRestartPlan(callerSession: string | null): Promise<RestartPlan> {
  const record = findDaemonRecord(daemonRecordFile);

  const paths = new Set([daemonSocketPath, ...(record === null ? [] : [record.socketPath])]);

  let probe: Probe | null = null;

  for (const path of paths) {
    probe = await tryProbe(path);

    if (probe !== null) {
      break;
    }
  }

  const pid =
    probe === null
      ? pickLivePID(record?.pid ?? null, findPidFilePID(daemonPidFile))
      : (pickStaleDaemonPID({
          socketPath: probe.socketPath,
          record,
          pidFileSocketPath: daemonSocketPath,
          pidFilePID: findPidFilePID(daemonPidFile),
        }) ?? pickLivePID(record?.pid ?? null, null));

  return {
    pid,
    socketPath: probe?.socketPath ?? null,
    answer: probe?.answer ?? null,
    sessions: probe?.sessions ?? null,
    callerSession,
    replacement: await planReplacement(pid),
  };
}

function pickLivePID(...candidates: readonly (number | null)[]): number | null {
  return candidates.find((pid) => pid !== null && isProcessAlive(pid)) ?? null;
}

async function planReplacement(pid: number | null): Promise<ReplacementPlan> {
  const unit = pid === null ? null : await findRestartUnit(pid);

  if (unit === null) {
    return { kind: 'plain', build: getBuild(), command: buildATCCommand(['daemon']).join(' ') };
  }

  const shown = await runSystemctl(['show', '-p', 'ExecStart', '--value', unit]);

  const execPath = /path=(?<path>[^\s;]+)/.exec(shown.stdout)?.groups?.['path'];

  return {
    kind: 'unit',
    unit,
    execStart: execPath ?? (shown.code === 0 && shown.stdout !== '' ? shown.stdout : null),
  };
}

async function tryProbe(socketPath: string): Promise<Probe | null> {
  let client: DaemonClient;

  try {
    client = await DaemonClient.open(socketPath);
  } catch {
    return null;
  }

  try {
    const hello = await client.sendHello(getBuild());

    const build = hello['daemon'];

    return {
      socketPath,
      answer: {
        kind: 'ok',
        build: typeof build === 'string' ? build : 'unknown',
        protocol: PROTOCOL_V,
      },
      sessions: await tryListSessions(client),
    };
  } catch (error) {
    if (error instanceof DaemonError && error.code === 'protocol_mismatch') {
      return { socketPath, answer: { kind: 'refused', message: error.message }, sessions: null };
    }

    return null;
  } finally {
    client.stop();
  }
}

async function tryListSessions(
  client: Pick<DaemonClient, 'sendRequest'>,
): Promise<PlanSession[] | null> {
  try {
    const listed = await client.sendRequest('session.list');

    const sessions = listed['sessions'];

    if (!Array.isArray(sessions)) {
      return null;
    }

    return sessions
      .filter((entry) => isRecord(entry))
      .map((entry) => ({
        id: String(entry['id']),
        name: String(entry['name']),
        state: String(entry['state']),
      }));
  } catch {
    return null;
  }
}
