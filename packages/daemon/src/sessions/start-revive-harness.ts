import type { HarnessHandle } from '@atc/plugin-api';
import type { AuthSetup } from '../auth/create-auth-setup';
import type { SessionFleetWriter } from '../fleet/create-session-fleet-writer';
import { buildHarnessEnv } from './build-harness-env';
import type { SessionHarnesses } from './create-session-harnesses';
import type { SessionRegistry } from './create-session-registry';
import { resolveRepoRoot } from './resolve-repo-root';
import type { Session } from './session';
import type { SessionCallbacks } from './session-callbacks';
import type { HarnessLaunch } from './types';

interface ReviveHarnessDeps {
  readonly registry: Pick<SessionRegistry, 'unrestored' | 'hasHostLifecycle'>;
  readonly fleet: Pick<SessionFleetWriter, 'emitChange' | 'tryWriteFleet'>;
  readonly harnesses: Pick<SessionHarnesses, 'attachHarness' | 'mintBridgeBinding'>;
  readonly auth: Pick<AuthSetup, 'buildBrokerSpec'>;
  readonly callbacks: Pick<
    SessionCallbacks,
    'onBoot' | 'onEvent' | 'onRelay' | 'getReporterSocketPath'
  >;
}

export function startReviveHarness(
  deps: ReviveHarnessDeps,
  session: Session,
  launch: HarnessLaunch,
): HarnessHandle {
  const registry = deps.registry;
  const fleet = deps.fleet;
  const harnesses = deps.harnesses;
  const auth = deps.auth;
  const callbacks = deps.callbacks;
  const plan = launch.plan;
  const provider = launch.provider;

  const binding = harnesses.mintBridgeBinding(
    session.id,
    session.target,
    session.targetIdentity,
    session.hostKey,
  );

  const pty = provider.spawnHarness({
    session: session.id,
    host: session.hostKey,
    bin: plan.bin,
    args: plan.args,
    cwd: session.cwd,
    env: buildHarnessEnv(
      plan.env,
      {
        sessionID: session.id,
        socket: callbacks.getReporterSocketPath(),
        ...(launch.recordPath === null ? {} : { sessionRecord: launch.recordPath }),
      },
      { daemonEnv: provider.remote ? {} : process.env, withheldEnv: session.withheldEnv },
    ),
    withheldEnv: session.withheldEnv,
    cols: launch.cols,
    rows: launch.rows,
    ...auth.buildBrokerSpec(session.hostKey, plan.admission),
    onRelay: (relay) => {
      callbacks.onRelay(binding, relay);
    },
  });

  session.bridgeEpoch = binding.epoch;
  session.pty = pty;
  session.kind = 'pty';
  session.lastMsg = 'revived';

  // A revive starts no turn, so a restored session keeps the state its agent last reported.
  // Forcing running would hide that state until the agent reports again.
  const isRestored = registry.unrestored.delete(session.id);

  if (!isRestored || session.state === 'exited') {
    session.state = 'running';
  }

  if (plan.admission === null) {
    delete session.authRevision;
  }

  session.repoRoot = provider.remote ? session.cwd : resolveRepoRoot(session.cwd);
  session.desired = 'run';
  session.suspended = false;

  harnesses.attachHarness(session, pty, registry.hasHostLifecycle(session.target));
  callbacks.onBoot(session, launch.cols, launch.rows);
  void fleet.tryWriteFleet(session.id);
  callbacks.onEvent('state', session);
  fleet.emitChange();

  return pty;
}
