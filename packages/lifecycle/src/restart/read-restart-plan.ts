import { isRecord } from '@atc/core';
import type { DaemonClient } from '@atc/protocol/client';
import { PROTOCOL_V } from '@atc/protocol/wire';
import { CONTRACT_MAJOR } from '@atcx/contract/light';
import { buildATCCommand } from '../boot/build-atc-command';
import { tryOpenDaemon } from '../boot/try-open-daemon';
import type { DaemonProbe } from '../boot/try-open-daemon';
import type { LifecycleHost } from '../boot/types';
import { buildHostDaemonPaths } from '../daemon-files/build-host-daemon-paths';
import { readDaemonPID } from '../daemon-files/read-daemon-pid';
import { readDaemonSocketPaths } from '../daemon-files/read-daemon-socket-paths';
import { readRestartUnit } from './read-restart-unit';
import type { DaemonAnswer, PlanSession, ReplacementPlan, RestartPlan } from './types';

const PROBE_DEADLINE_MS = 3000;

export async function readRestartPlan(
  host: LifecycleHost,
  callerSession: string | null,
): Promise<RestartPlan> {
  const paths = buildHostDaemonPaths(host);

  const probe = await tryOpenDaemon(
    readDaemonSocketPaths(paths),
    {
      build: host.invocation.readBuild(),
      deadline: host.clock.now() + PROBE_DEADLINE_MS,
      clock: host.clock,
    },
    tryListSessions,
  );

  const pid = readDaemonPID(probe?.socketPath ?? null, {
    paths,
    stateDir: host.paths.stateDir,
    procRoot: host.procRoot,
  });

  return {
    pid,
    socketPath: probe?.socketPath ?? null,
    answer: pickAnswer(probe),
    sessions: probe?.kind === 'ok' ? probe.value : null,
    callerSession,
    replacement: await planReplacement(pid, host),
  };
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

function pickAnswer(probe: DaemonProbe<unknown> | null): DaemonAnswer | null {
  if (probe === null) {
    return null;
  }

  return probe.kind === 'ok'
    ? { kind: 'ok', build: probe.hello.build, protocol: PROTOCOL_V, major: CONTRACT_MAJOR }
    : { kind: 'refused', message: probe.message };
}

async function planReplacement(pid: number | null, host: LifecycleHost): Promise<ReplacementPlan> {
  const unit = pid === null ? null : await readRestartUnit(pid, host);

  if (pid === null || unit === null) {
    return {
      kind: 'plain',
      build: host.invocation.readBuild(),
      command: buildATCCommand(host.invocation.argv, ['daemon']).join(' '),
    };
  }

  const shown = await host.runSystemctl(['show', '-p', 'ExecStart', '--value', unit]);

  const execPath = /path=(?<path>[^\s;]+)/u.exec(shown.stdout)?.groups?.['path'];

  return {
    kind: 'unit',
    unit,
    pid,
    execStart: execPath ?? (shown.code === 0 && shown.stdout !== '' ? shown.stdout : null),
  };
}
