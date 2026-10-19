import { isRecord } from '@atc/core';
import type { DaemonClient } from '@atc/protocol/client';
import { PROTOCOL_V } from '@atc/protocol/wire';
import { buildATCCommand } from './build-atc-command';
import { buildHostDaemonPaths } from './build-host-daemon-paths';
import { collectDaemonSocketPaths } from './collect-daemon-socket-paths';
import { findDaemonPID } from './find-daemon-pid';
import { findRestartUnit } from './find-restart-unit';
import type { LifecycleHost } from './lifecycle-host';
import type { DaemonAnswer, PlanSession, ReplacementPlan, RestartPlan } from './restart-plan';
import { tryOpenDaemon } from './try-open-daemon';
import type { DaemonProbe } from './try-open-daemon';

// How long the handshake and the session list may take together.
const PROBE_DEADLINE_MS = 3000;

export async function collectRestartPlan(
  host: LifecycleHost,
  callerSession: string | null,
): Promise<RestartPlan> {
  const paths = buildHostDaemonPaths(host);

  const probe = await tryOpenDaemon(
    collectDaemonSocketPaths(paths),
    {
      build: host.invocation.readBuild(),
      deadline: host.clock.now() + PROBE_DEADLINE_MS,
      clock: host.clock,
    },
    tryListSessions,
  );

  const pid = findDaemonPID(probe?.socketPath ?? null, {
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
    ? { kind: 'ok', build: probe.hello.build, protocol: PROTOCOL_V }
    : { kind: 'refused', message: probe.message };
}

async function planReplacement(pid: number | null, host: LifecycleHost): Promise<ReplacementPlan> {
  const unit = pid === null ? null : await findRestartUnit(pid, host);

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
