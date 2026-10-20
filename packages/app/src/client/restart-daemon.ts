import { loadConfig } from '@atc/config';
import type { Clock } from '@atc/core';
import type { DaemonBoot } from '@atc/protocol';
import type { DaemonClient } from '@atc/protocol/client';
import type { DaemonTransport } from '@atc/protocol/wire/transport';
import { SHIPPED_HARNESS_PLUGINS } from '../plugins/shipped-harness-plugins';
import type { ClientActor } from './build-client-machine';
import type { FleetMirror } from './fleet-mirror';
import type { OverlayScreen } from './overlay-screen';
import { resolveAgentMetadata } from './resolve-agent-metadata';
import { cols } from './ui';

// What a restart borrows from the client that owns the screen, the fleet
// mirror, and the daemon connection.
export interface RestartDaemonDeps<TLink> {
  readonly service: ClientActor;
  readonly mirror: FleetMirror;
  readonly overlay: OverlayScreen;
  readonly transport: DaemonTransport<TLink>;
  readonly clock: Clock;
  readonly getBoot: () => DaemonBoot;
  readonly getClient: () => DaemonClient;
  readonly restartDaemonAt: (socketPath: string) => Promise<boolean>;
  readonly sendQuiet: (method: string, params?: Readonly<Record<string, unknown>>) => Promise<void>;
  readonly logClientEvent: (line: string) => void;
  readonly scheduleStatus: () => void;
  readonly ptyRows: () => number;
}

export async function restartDaemon<TLink>(deps: RestartDaemonDeps<TLink>) {
  // The step `atc daemon restart` takes: the user service that runs the
  // daemon restarts, or the daemon stops. A daemon that cannot be found or
  // restarted stays in service, and the client stays on it.
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

  // a new daemon may map aliases and targets differently, so rows fall back to the config
  // baseline, and the target column hides, until its own answer arrives.
  const baseline = resolveAgentMetadata(loadConfig(SHIPPED_HARNESS_PLUGINS), {});

  deps.overlay.agentLabels = baseline.labels;
  deps.overlay.agentModels = baseline.models;
  deps.overlay.availableTargets = 0;

  // The transport reconnects once the old connection is dropped, and
  // refuses the old daemon while it still answers.
  deps.service.send({ type: 'RESTART_AWAITING_FRESH', freshUntil: deps.clock.now() + 8000 });

  const old = deps.transport.findLatest();

  if (old !== null) {
    deps.transport.stopConnection(old);
  }

  // A new daemon that has not answered by the deadline shows as a wait like
  // any other, with each failed open logged; the restore still runs once
  // it answers.
  const cancelLate = deps.clock.schedule(() => {
    deps.service.send({ type: 'RESTART_ENDED', connected: false });
    deps.logClientEvent('restart: the new daemon has not answered in 8s; still trying');
    deps.scheduleStatus();
  }, 8000);

  await deps.transport.waitForConnection();

  cancelLate();

  await deps.sendQuiet('fleet.restore', { cols: cols(), rows: deps.ptyRows() });
  await deps.mirror.refresh(deps.getClient).catch(() => {});
  await deps.overlay.refreshAgents();

  deps.service.send({ type: 'OVERLAY' });
}
