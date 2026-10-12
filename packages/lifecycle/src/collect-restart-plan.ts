import { daemonPidFile, daemonRecordFile, daemonSocketPath, stateDir } from '@atc/config/config';
import { isRecord } from '@atc/core/is-record';
import { systemClock } from '@atc/core/system-clock';
import type { Clock } from '@atc/core/system-clock';
import { DaemonClient } from '@atc/protocol/client/daemon-client';
import { DaemonError } from '@atc/protocol/daemon-error';
import { PROTOCOL_V } from '@atc/protocol/protocol';
import { readSessionEnv } from '@atc/protocol/read-session-env';
import type { ATCInvocation } from './atc-invocation';
import { buildATCCommand } from './build-atc-command';
import { findDaemonRecord } from './find-daemon-record';
import { findPidFilePID } from './find-pid-file-pid';
import { findRestartUnit } from './find-restart-unit';
import { isDaemonProcess } from './is-daemon-process';
import { isProcessAlive } from './is-process-alive';
import { pickStaleDaemonPID } from './pick-stale-daemon-pid';
import type { DaemonAnswer, PlanSession, ReplacementPlan, RestartPlan } from './restart-plan';
import { runSystemctl } from './run-systemctl';

// How long the handshake and the session list may take together.
const PROBE_DEADLINE_MS = 3000;

interface Probe {
  readonly socketPath: string;
  readonly answer: DaemonAnswer;
  readonly sessions: readonly PlanSession[] | null;
}

/**
 * Finds the daemon a restart would stop and the replacement it would start,
 * without changing either. The daemon answers on the socket this
 * environment computes or the one its record in the state directory holds,
 * and a handshake that its protocol refuses still identifies it. The probe's
 * time limit runs on the clock, and the probe and a plain replacement take
 * this build's stamp and argv from the invocation.
 */
export async function collectRestartPlan(
  invocation: ATCInvocation,
  callerSession: string | null,
  clock: Clock = systemClock,
): Promise<RestartPlan> {
  const record = findDaemonRecord(daemonRecordFile);

  const paths = new Set([daemonSocketPath, ...(record === null ? [] : [record.socketPath])]);

  let probe: Probe | null = null;

  for (const path of paths) {
    probe = await tryProbe(path, invocation.readBuild(), clock);

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
    replacement: await planReplacement(pid, invocation),
  };
}

function pickLivePID(...candidates: readonly (number | null)[]): number | null {
  return (
    candidates.find(
      (pid) => pid !== null && isProcessAlive(pid) && isDaemonProcess(pid, stateDir),
    ) ?? null
  );
}

async function planReplacement(
  pid: number | null,
  invocation: ATCInvocation,
): Promise<ReplacementPlan> {
  const unit = pid === null ? null : await findRestartUnit(pid);

  if (unit === null) {
    return {
      kind: 'plain',
      build: invocation.readBuild(),
      command: buildATCCommand(invocation.argv, ['daemon']).join(' '),
    };
  }

  const shown = await runSystemctl(['show', '-p', 'ExecStart', '--value', unit]);

  const execPath = /path=(?<path>[^\s;]+)/.exec(shown.stdout)?.groups?.['path'];

  return {
    kind: 'unit',
    unit,
    execStart: execPath ?? (shown.code === 0 && shown.stdout !== '' ? shown.stdout : null),
  };
}

async function tryProbe(socketPath: string, build: string, clock: Clock): Promise<Probe | null> {
  let client: DaemonClient;

  try {
    client = await DaemonClient.open(socketPath);
  } catch {
    return null;
  }

  // A daemon that accepts the socket and never answers must not hang the
  // restart: closing the client rejects every request still waiting.
  const cancelExpiry = clock.schedule(() => {
    client.stop();
  }, PROBE_DEADLINE_MS);

  try {
    const hello = await client.sendHello(build, {
      session: readSessionEnv(process.env).sessionID,
    });

    const daemonBuild = hello['daemon'];

    return {
      socketPath,
      answer: {
        kind: 'ok',
        build: typeof daemonBuild === 'string' ? daemonBuild : 'unknown',
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
    cancelExpiry();

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
