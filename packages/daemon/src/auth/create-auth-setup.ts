import type { AgentID, SessionID, StepTimer } from '@atc/core';
import type {
  AgentAdapter,
  CredentialBroker,
  ExecutionProvider,
  GuestPaths,
  HarnessSpec,
  SpawnOptions,
  SpawnPlan,
} from '@atc/plugin-api';
import { DaemonError } from '@atc/protocol/wire';
import type { FleetStore, RuntimeAuthBinding } from '@atc/store';
import type { SessionFleetWriter } from '../fleet/create-session-fleet-writer';
import type { HostDirClaims } from '../sessions/create-host-dir-claims';
import type { SessionHarnesses } from '../sessions/create-session-harnesses';
import type { SessionRegistry } from '../sessions/create-session-registry';
import type { SessionCallbacks } from '../sessions/session-callbacks';
import type { SpawnRollback } from '../sessions/spawn-rollback';
import { buildAuthBinding } from './build-auth-binding';
import type { AuthBinding } from './build-auth-binding';
import { buildBrokerTargetRefusal } from './build-broker-target-refusal';
import { buildGuestRefusal } from './build-guest-refusal';
import type { RuntimeAuthBinder } from './create-runtime-auth-binder';
import { formatAuthNotice } from './format-auth-notice';
import { loadOAuthStates } from './load-oauth-states';
import { requireGuestEnv } from './require-guest-env';
import { requireProjectSettings } from './require-project-settings';
import { setupGuest } from './setup-guest';

// A readied host's harness plan, and the auth attempt that provisioned the
// host, if one did.
export interface HarnessSetup {
  readonly plan: HarnessPlan;
  readonly attemptID: string | null;
}

// How a harness takes its credential from impd's broker: the broker the
// provider reaches, and the binding the agent's selection resolves to now.
interface HarnessAuth {
  readonly host: CredentialBroker;
  readonly binding: AuthBinding;
}

// A harness's auth as its setup applies it: a spawn's own new host creates
// the binding, and every other launch verifies the one its host holds.
export interface HarnessAuthSetup extends HarnessAuth {
  readonly mode: 'create' | 'verify';
  readonly targetIdentity: string;
}

// A verified binding and the revision it held before the verify, which a
// rebind inside the verify moves on from.
interface VerifiedAuth {
  readonly binding: RuntimeAuthBinding;
  readonly heldRevision: number;
}

// A harness as its setup plans it: the agent's spawn, and the variables
// the agent's plan starts the harness with, which no variable atc adds
// overrides.
export interface HarnessPlan extends SpawnPlan {
  readonly env: Readonly<Record<string, string>>;

  // What a launch behind the broker was planned under, which its host's
  // binding must still admit when each request goes out; null without
  // runtime auth.
  readonly admission: {
    readonly revision: number;
    readonly hash: string;
    readonly attemptID: string | null;
  } | null;

  // the revision the host's binding held before this launch verified it, the latest a process
  // the start attaches to can have launched under; null when the launch creates its binding or
  // takes no runtime auth
  readonly heldRevision: number | null;
}

export interface AuthRebound {
  readonly revision: number;
  readonly restartPending: readonly SessionID[];
}

export interface AuthSetup {
  // throws before a spawn or an adopt does any work, for an agent that needs a broker the
  // target does not reach or the daemon cannot bind
  readonly requireAgentTarget: (agent: AgentID, target: string) => void;

  // null when the agent may start on this provider under the host's own sign-in; an agent that
  // starts only behind the broker is refused instead, so it never falls back to a local start
  readonly resolveHarnessAuth: (
    adapter: AgentAdapter,
    provider: ExecutionProvider,
    target: string,
  ) => HarnessAuth | null;

  // A sub-session joins its parent's host only under the binding that host
  // holds: both without runtime auth, or both bound to the same hash, and
  // then only while that binding is ready.
  readonly requireSharedBinding: (hostKey: SessionID, binding: AuthBinding | null) => Promise<void>;

  // every refusal comes before the harness starts; a failure once the host is readied takes
  // back the binding this call created, or destroys a spawn's own new host
  readonly setupHarnessOnHost: (
    adapter: AgentAdapter,
    provider: ExecutionProvider,
    id: SessionID,
    hostKey: SessionID,
    target: string,
    options: SpawnOptions,
    auth: HarnessAuthSetup | null,

    // The directory the harness starts in, whose project settings a launch
    // behind the broker reads once the host is ready; null for a spawn
    // whose workspace is built after this, which reads them once it is.
    cwd: string | null,

    // Whether the host is a spawn's new host of its own, which a failure
    // once it is readied destroys.
    isNewHost: boolean,
    timer: StepTimer,
  ) => Promise<{ readonly plan: HarnessPlan; readonly attemptID: string | null }>;

  // The part of a harness spec that keeps a launch behind the broker: the
  // requirement impd checks, and the admission each request needs from
  // the host's binding when it goes out.
  readonly buildBrokerSpec: (
    hostKey: SessionID,
    admission: HarnessPlan['admission'],
  ) => Pick<HarnessSpec, 'requireBroker' | 'admit'>;

  readonly requireProjectSettings: (
    adapter: AgentAdapter,
    provider: ExecutionProvider,
    hostKey: SessionID,
    target: string,
    cwd: string,
  ) => Promise<void>;

  // launches on the host stay blocked until a rebind; a running harness keeps running while
  // impd fails its later requests
  readonly revokeAuth: (id: SessionID) => Promise<boolean>;

  readonly updateAuth: (id: SessionID) => Promise<AuthRebound | null>;

  readonly requireAuthBinder: () => RuntimeAuthBinder;
}

interface AuthSetupDeps {
  readonly registry: Pick<
    SessionRegistry,
    'sessions' | 'targets' | 'findAdapter' | 'findProvider' | 'requireExecution'
  >;
  readonly fleet: Pick<SessionFleetWriter, 'emitChange'>;
  readonly claims: Pick<HostDirClaims, 'resolveHostHome'>;
  readonly harnesses: Pick<SessionHarnesses, 'authRevisions' | 'isAuthOutdated' | 'isHostIdle'>;
  readonly rollback: Pick<SpawnRollback, 'destroyFailedSpawnHost'>;
  readonly store: Pick<FleetStore, 'daemonID'>;
  readonly callbacks: Pick<SessionCallbacks, 'onEvent' | 'log' | 'findAuthBinder'>;
}

export function createAuthSetup(deps: AuthSetupDeps): AuthSetup {
  const registry = deps.registry;
  const fleet = deps.fleet;
  const claims = deps.claims;
  const harnesses = deps.harnesses;
  const rollback = deps.rollback;
  const store = deps.store;
  const callbacks = deps.callbacks;

  const requireAuthBinder = (): RuntimeAuthBinder => {
    const binder = callbacks.findAuthBinder();

    if (binder === null) {
      throw new DaemonError('unsupported_operation', 'this daemon binds no runtime auth', {
        problem: 'no_auth_binder',
      });
    }

    return binder;
  };

  const resolveHarnessAuth = (
    adapter: AgentAdapter,
    provider: ExecutionProvider,
    target: string,
  ): HarnessAuth | null => {
    const selection = adapter.findAuthSelection?.() ?? null;

    if (selection === null) {
      return null;
    }

    const host = provider.brokerAuth;

    if (host === undefined && !selection.brokerRequired) {
      return null;
    }

    if (host === undefined || callbacks.findAuthBinder() === null) {
      throw buildBrokerTargetRefusal(adapter.id, target);
    }

    const planned = buildAuthBinding(selection.gateway, selection.profiles);

    if ('problem' in planned) {
      throw new DaemonError('auth_binding_invalid', planned.problem.message, {
        agent: adapter.id,
        problem: planned.problem.code,
      });
    }

    return { host, binding: planned.binding };
  };

  // A launch without runtime auth never starts on a host that holds a
  // binding, whatever its state: the imp may hold grants atc could not
  // confirm gone, and only a rebind or a forget of the host clears it.
  const requireUnboundHost = async (agent: string, hostKey: SessionID): Promise<void> => {
    const binder = callbacks.findAuthBinder();
    const held = binder === null ? null : await binder.readBinding(hostKey);

    if (held !== null) {
      throw new DaemonError(
        'auth_rebind_required',
        `agent '${agent}' takes no credential from impd's broker, but its host holds a runtime auth binding; give the agent its auth block back, or forget the session`,
        { agent, state: held.state, problem: 'auth_dropped' },
      );
    }
  };

  const verifyHarnessAuth = async (
    agent: AgentID,
    provider: ExecutionProvider,
    hostKey: SessionID,
    auth: HarnessAuthSetup,
  ): Promise<VerifiedAuth> => {
    // only a host whose every session runs this agent rebinds: two agents that select
    // different profiles would each move the host back on their own launches
    const isSoleAgent = registry.sessions.every(
      (other) => other.hostKey !== hostKey || other.agent === agent,
    );

    const rebind =
      provider.rebindChangedAuth === true && isSoleAgent
        ? {
            log: (line: string) => {
              callbacks.log(line);
            },
          }
        : null;

    const binder = requireAuthBinder();

    const held = await binder.readBinding(hostKey);
    const row = await binder.verifyBinding(auth.host, hostKey, auth.binding, rebind);

    harnesses.authRevisions.set(hostKey, row.revision);

    const older = registry.sessions.filter(
      (other) => other.hostKey === hostKey && other.pty !== null && harnesses.isAuthOutdated(other),
    );

    for (const other of older) {
      other.lastMsg = formatAuthNotice(row.revision);

      callbacks.onEvent('state', other);
    }

    if (older.length > 0) {
      fleet.emitChange();
    }

    return { binding: row, heldRevision: held?.revision ?? row.revision };
  };

  const self: AuthSetup = {
    requireAgentTarget: (agent, target) => {
      const selection = registry.findAdapter(agent)?.findAuthSelection?.() ?? null;

      if (selection === null) {
        return;
      }

      const host = registry.targets.get(target)?.provider?.brokerAuth;

      if (host === undefined && !selection.brokerRequired) {
        return;
      }

      if (host === undefined || callbacks.findAuthBinder() === null) {
        throw buildBrokerTargetRefusal(agent, target);
      }
    },

    resolveHarnessAuth,

    requireSharedBinding: async (hostKey, binding) => {
      const found = await callbacks.findAuthBinder()?.readBinding(hostKey);

      const held = found ?? null;

      if (held === null && binding === null) {
        return;
      }

      if (held !== null && binding !== null && held.bindingHash === binding.hash) {
        if (held.state !== 'ready') {
          throw new DaemonError(
            'auth_blocked',
            `the runtime auth of host ${hostKey} is ${held.state}; rebind it to launch again`,
            { host: hostKey, state: held.state },
          );
        }

        return;
      }

      throw new DaemonError(
        'auth_binding_mismatch',
        `a sub-session joins the host of session ${hostKey} only under the runtime auth binding that host holds`,
        { host: hostKey, hostBound: held !== null, bound: binding !== null },
      );
    },

    setupHarnessOnHost: async (
      adapter,
      provider,
      id,
      hostKey,
      target,
      options,
      auth,
      cwd,
      isNewHost,
      timer,
    ) => {
      const refusal = adapter.findSpawnRefusal?.() ?? null;

      if (refusal !== null) {
        throw refusal;
      }

      if (auth === null) {
        await requireUnboundHost(adapter.id, hostKey);
      }

      if (!provider.remote) {
        await provider.prepareHost({
          host: hostKey,
          daemonID: store.daemonID,
          isIdle: () => harnesses.isHostIdle(hostKey, target),
          timer,
        });

        const local = adapter.planSpawn(options, id);

        return {
          plan: {
            bin: local.bin,
            args: local.args,
            env: local.env ?? {},
            admission: null,
            heldRevision: null,
          },
          attemptID: null,
        };
      }

      const guest = provider.guest ?? { directory: '/tmp/atc', atc: null };
      const directory = `${guest.directory}/sessions/${id}`;

      // A launch on a bound host verifies the binding before it plans, since
      // a target that rebinds a changed selection moves the binding to the
      // revision the plan then launches under.
      const verified =
        auth?.mode === 'verify'
          ? await timer.withStep('auth-binding', () =>
              verifyHarnessAuth(adapter.id, provider, hostKey, auth),
            )
          : null;

      const paths: GuestPaths =
        auth === null
          ? { atc: guest.atc, directory }
          : {
              atc: guest.atc,
              directory,
              auth: await timer.withStep('auth-plan', () =>
                planGuestAuth(auth, verified?.binding.revision ?? 1),
              ),
            };

      const plan =
        adapter.planGuestSpawn === undefined
          ? { ...adapter.planSpawn(options), files: {} }
          : adapter.planGuestSpawn(options, paths);

      if (plan === null) {
        throw auth === null
          ? buildGuestRefusal(provider.kind, adapter.id, target, guest.atc === null)
          : new DaemonError(
              'auth_target_unsupported',
              `agent '${adapter.id}' plans no guest settings to take its credential from impd's broker on target '${target}'`,
              { agent: adapter.id, target, problem: 'no_guest_plan' },
            );
      }

      const env = plan.env ?? {};

      requireGuestEnv(adapter.id, target, env, auth !== null);

      const attemptID =
        auth?.mode === 'create'
          ? await timer.withStep('auth-binding', () =>
              requireAuthBinder().createBinding(auth.host, {
                hostKey,
                target,
                targetIdentity: auth.targetIdentity,
                binding: auth.binding,
              }),
            )
          : null;

      try {
        await setupGuest(
          { store, callbacks, harnesses },
          { adapter, provider, hostKey, target, directory, planned: plan.files, timer },
        );

        if (auth !== null && cwd !== null) {
          await timer.withStep('project-settings', () =>
            self.requireProjectSettings(adapter, provider, hostKey, target, cwd),
          );
        }
      } catch (error) {
        if (attemptID !== null || isNewHost) {
          await rollback.destroyFailedSpawnHost(provider, id, hostKey, attemptID);
        }

        throw error;
      }

      const admission =
        auth === null || paths.auth === undefined
          ? null
          : { revision: paths.auth.revision, hash: auth.binding.hash, attemptID };

      return {
        plan: {
          bin: plan.bin,
          args: plan.args,
          env,
          admission,
          heldRevision: verified?.heldRevision ?? null,
        },
        attemptID,
      };
    },

    buildBrokerSpec: (hostKey, admission) => {
      if (admission === null) {
        return {};
      }

      const binder = requireAuthBinder();

      return {
        requireBroker: true,
        admit: (kind, send) => binder.withLaunchAdmission(hostKey, admission, kind, send),
      };
    },

    requireProjectSettings: (adapter, provider, hostKey, target, cwd) =>
      requireProjectSettings(claims, { adapter, provider, hostKey, target, cwd }),

    revokeAuth: async (id) => {
      const session = registry.sessions.find((x) => x.id === id);

      if (session === undefined) {
        return false;
      }

      await requireAuthBinder().revokeBinding(
        registry.findProvider(session)?.brokerAuth ?? null,
        session.hostKey,
      );

      return true;
    },

    updateAuth: async (id) => {
      const session = registry.sessions.find((x) => x.id === id);

      if (session === undefined) {
        return null;
      }

      const adapter = registry.findAdapter(session.agent);

      if (adapter === null) {
        throw new DaemonError('unsupported_operation', `no adapter for agent '${session.agent}'`, {
          agent: session.agent,
        });
      }

      const provider = registry.requireExecution(session, 'spawn').provider;
      const auth = resolveHarnessAuth(adapter, provider, session.target);

      if (auth === null) {
        throw new DaemonError(
          'unsupported_operation',
          `agent '${session.agent}' takes no credential from impd's broker`,
          { agent: session.agent, problem: 'no_auth_selection' },
        );
      }

      const revision = await requireAuthBinder().updateBinding(
        auth.host,
        session.hostKey,
        auth.binding,
      );

      harnesses.authRevisions.set(session.hostKey, revision);

      // a harness keeps the settings it launched with, so each one under an older revision shows
      // that the new one applies at its next launch
      const pending = registry.sessions.filter(
        (other) => other.hostKey === session.hostKey && harnesses.isAuthOutdated(other),
      );

      for (const other of pending) {
        other.lastMsg = formatAuthNotice(revision);

        callbacks.onEvent('state', other);
      }

      if (pending.length > 0) {
        fleet.emitChange();
      }

      return { revision, restartPending: pending.map((other) => other.id) };
    },

    requireAuthBinder,
  };

  return self;
}

// The binding revision and placeholders a guest plan behind the broker
// launches under, with the sign-in state impd lists for each oauth
// secret the binding holds.
async function planGuestAuth(
  auth: HarnessAuthSetup,
  revision: number,
): Promise<NonNullable<GuestPaths['auth']>> {
  const oauth = await loadOAuthStates(auth.host, auth.binding);

  return {
    revision,
    env: auth.binding.placeholderEnv,
    profileEnv: auth.binding.profileEnv,
    ...(oauth === undefined ? {} : { oauth }),
  };
}
