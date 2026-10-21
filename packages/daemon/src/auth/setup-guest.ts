import type { SessionID, StepTimer } from '@atc/core';
import { buildTarArchive } from '@atc/core';
import type { AgentAdapter, ExecutionProvider, GuestSpawnPlan } from '@atc/plugin-api';
import { DaemonError } from '@atc/protocol/wire';
import type { FleetStore } from '@atc/store';
import type { SessionHarnesses } from '../sessions/create-session-harnesses';
import type { SessionCallbacks } from '../sessions/session-callbacks';

// What a guest's setup reads from the daemon: its id, its log, and whether
// a host is idle.
interface GuestSetupDeps {
  readonly store: Pick<FleetStore, 'daemonID'>;
  readonly callbacks: Pick<SessionCallbacks, 'log'>;
  readonly harnesses: Pick<SessionHarnesses, 'isHostIdle'>;
}

// The guest a remote launch readies: the agent and provider, the host and
// target, the directory its planned files go to, and the step timer.
interface GuestSetup {
  readonly adapter: AgentAdapter;
  readonly provider: ExecutionProvider;
  readonly hostKey: SessionID;
  readonly target: string;
  readonly directory: string;
  readonly planned: GuestSpawnPlan['files'];
  readonly timer: StepTimer;
}

// Readies a remote host and the files a guest plan reads there, after
// the agent's sign-in check.
export async function setupGuest(deps: GuestSetupDeps, guest: GuestSetup): Promise<void> {
  const adapter = guest.adapter;
  const provider = guest.provider;
  const hostKey = guest.hostKey;
  const target = guest.target;
  const directory = guest.directory;
  const planned = guest.planned;
  const timer = guest.timer;

  await provider.prepareHost({
    host: hostKey,
    daemonID: deps.store.daemonID,
    installATC: adapter.planGuestSpawn !== undefined,
    log: deps.callbacks.log,
    isIdle: () => deps.harnesses.isHostIdle(hostKey, target),
    timer,
  });

  const check = adapter.planAuthCheck?.();

  if (check !== undefined) {
    const result = await timer.withStep('auth-check', () =>
      provider.runCommand({ argv: check, cwd: '/', host: hostKey }),
    );

    if (result.exitCode !== 0) {
      throw new DaemonError(
        'auth_not_configured',
        `agent '${adapter.id}' is not signed in on target '${target}'; sign it in inside the host's image`,
        { agent: adapter.id, target },
      );
    }
  }

  const files = Object.entries(planned).map(([path, file]) =>
    typeof file === 'string' || file instanceof Uint8Array
      ? { path, content: file }
      : { path, content: file.content, mode: file.mode },
  );

  if (files.length > 0) {
    await timer.withStep('settings-transfer', () =>
      provider.transferArchive(buildTarArchive(files), directory, hostKey),
    );
  }
}
