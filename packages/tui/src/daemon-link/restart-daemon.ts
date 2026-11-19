import type { Config } from '@atc/config';
import type { Clock } from '@atc/core';
import type { DaemonBoot } from '@atc/protocol';
import type { DaemonClient } from '@atc/protocol/client';
import type { DaemonTransport } from '@atc/protocol/wire/transport';
import type { ClientActor } from '../client/build-client-machine';
import type { FleetMirror } from '../fleet/create-fleet-mirror';
import { resolveAgentMetadata } from '../fleet/resolve-agent-metadata';
import type { DaemonName } from '../fleet/session-key';
import type { OverlayScreen } from '../overlay/create-overlay-screen';
import { cols } from '../terminal/cols';

export interface RestartDaemonDeps<TLink> {
  readonly service: ClientActor;
  readonly mirror: FleetMirror;
  readonly overlay: OverlayScreen;
  readonly transport: DaemonTransport<TLink>;
  readonly clock: Clock;
  readonly getBoot: () => DaemonBoot;
  readonly getClient: () => DaemonClient;
  readonly restartDaemonAt: (socketPath: string) => Promise<boolean>;
  readonly readConfig: () => Config;
  readonly primary: DaemonName;
  readonly sendQuiet: (
    daemon: DaemonName,
    method: string,
    params?: Readonly<Record<string, unknown>>,
  ) => Promise<void>;
  readonly logClientEvent: (line: string) => void;
  readonly scheduleStatus: () => void;
  readonly ptyRows: () => number;
}

export async function restartDaemon<TLink>(deps: RestartDaemonDeps<TLink>) {
  const socketPath = deps.getBoot().socketPath;
  let restarted: boolean;

  try {
    restarted = await deps.restartDaemonAt(socketPath);
  } catch (error) {
    deps.logClientEvent(
      `restart: ${error instanceof Error ? error.message : String(error)}; the daemon was left running`,
    );

    return;
  }

  if (!restarted) {
    deps.logClientEvent(
      `restart: no pid found for the daemon at ${socketPath}; it was left running`,
    );

    return;
  }

  // a new daemon may map aliases and targets differently
  const baseline = resolveAgentMetadata(deps.readConfig(), {});

  deps.overlay.agentLabels = baseline.labels;
  deps.overlay.agentModels = baseline.models;
  deps.overlay.availableTargets = 0;

  deps.service.send({ type: 'RESTART_AWAITING_FRESH', freshUntil: deps.clock.now() + 8000 });

  const old = deps.transport.findLatest();

  if (old !== null) {
    deps.transport.stopConnection(old);
  }

  const cancelLate = deps.clock.schedule(() => {
    deps.service.send({ type: 'RESTART_ENDED', connected: false });
    deps.logClientEvent('restart: the new daemon has not answered in 8s; still trying');
    deps.scheduleStatus();
  }, 8000);

  await deps.transport.waitForConnection();

  cancelLate();

  await deps.sendQuiet(deps.primary, 'fleet.restore', { cols: cols(), rows: deps.ptyRows() });
  await deps.mirror.refresh(deps.primary, deps.getClient()).catch(() => {});
  await deps.overlay.refreshAgents();

  deps.service.send({ type: 'OVERLAY' });
}
