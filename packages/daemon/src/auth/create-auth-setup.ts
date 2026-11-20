import type { AgentID, StepTimer } from '@atc/core';
import type {
  AgentAdapter,
  ExecutionProvider,
  GuestPaths,
  HarnessSpec,
  SpawnOptions,
} from '@atc/plugin-api';
import { findHostBroker, getHostCredentials } from '@atc/plugin-api';
import type { FleetStore, RuntimeAuthBinding } from '@atc/store';
import type { SessionID } from '@atcx/contract';
import { AtcError } from '@atcx/contract/light';
import type { SessionFleetWriter } from '../fleet/create-session-fleet-writer';
import { buildGuestSessionDirectory } from '../sessions/build-guest-session-directory';
import type { HostDirClaims } from '../sessions/create-host-dir-claims';
import type { SessionHarnesses } from '../sessions/create-session-harnesses';
import type { SessionRegistry } from '../sessions/create-session-registry';
import type { SpawnRollback } from '../sessions/create-spawn-rollback';
import { readGuestLayout } from '../sessions/read-guest-layout';
import type { SessionCallbacks } from '../sessions/session-callbacks';
import { buildAuthBinding } from './build-auth-binding';
import type { AuthBinding } from './build-auth-binding';
import { buildGuestRefusal } from './build-guest-refusal';
import { buildHarnessAuthDecision } from './build-harness-auth-decision';
import { buildHarnessAuthRefusal } from './build-harness-auth-refusal';
import type { RuntimeAuthBinder } from './create-runtime-auth-binder';
import type { HarnessAuthDecision } from './decide-harness-auth';
import { formatAuthNotice } from './format-auth-notice';
import { planGuestAuth } from './plan-guest-auth';
import { planHarnessOnGuest } from './plan-harness-on-guest';
import { readHostAgentHome } from './read-host-agent-home';
import { requireGuestEnv } from './require-guest-env';
import { requireNotRouted } from './require-not-routed';
import { requireProjectSettings } from './require-project-settings';
import type { ProjectSettingsLaunch } from './require-project-settings';
import { setupGuest } from './setup-guest';
import type { AuthRebound, HarnessAuth, HarnessAuthSetup, HarnessPlan } from './types';

interface VerifiedAuth {
  readonly binding: RuntimeAuthBinding;
  readonly heldRevision: number;
}

interface SetupHarnessOnHostParams {
  readonly adapter: AgentAdapter;
  readonly provider: ExecutionProvider;
  readonly id: SessionID;
  readonly hostKey: SessionID;
  readonly target: string;
  readonly spawnOptions: SpawnOptions;
  readonly auth: HarnessAuthSetup | null;

  readonly cwd: string | null;

  readonly isNewHost: boolean;
  readonly timer: StepTimer;
}

export interface AuthSetup {
  readonly requireAgentTarget: (agent: AgentID, target: string) => void;

  readonly resolveHarnessAuth: (
    adapter: AgentAdapter,
    provider: ExecutionProvider,
    target: string,
  ) => HarnessAuth | null;

  readonly requireSharedBinding: (hostKey: SessionID, binding: AuthBinding | null) => Promise<void>;

  readonly setupHarnessOnHost: (
    params: SetupHarnessOnHostParams,
  ) => Promise<{ readonly plan: HarnessPlan; readonly attemptID: string | null }>;

  readonly buildBrokerSpec: (
    hostKey: SessionID,
    admission: HarnessPlan['admission'],
  ) => Pick<HarnessSpec, 'requireBroker' | 'admit'>;

  readonly requireProjectSettings: (launch: ProjectSettingsLaunch) => Promise<void>;

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
      throw new AtcError('unsupported_operation', 'this daemon binds no runtime auth', {
        problem: 'no_auth_binder',
      });
    }

    return binder;
  };

  const requireAuthDecision = (
    adapter: AgentAdapter,
    provider: Pick<ExecutionProvider, 'credentials'>,
    target: string,
  ): Exclude<HarnessAuthDecision, { readonly kind: 'refused' }> => {
    const credentials = getHostCredentials(provider);
    const decision = buildHarnessAuthDecision(adapter, credentials);

    if (decision.kind === 'refused') {
      const variable =
        credentials.kind === 'none'
          ? null
          : (adapter.findGuestEnvConflict?.(credentials.kind) ?? null);

      throw buildHarnessAuthRefusal(adapter.id, target, decision.problem, variable);
    }

    if (decision.kind === 'broker') {
      requireAuthBinder();
    }

    return decision;
  };

  const resolveHarnessAuth = (
    adapter: AgentAdapter,
    provider: ExecutionProvider,
    target: string,
  ): HarnessAuth | null => {
    const decision = requireAuthDecision(adapter, provider, target);

    if (decision.kind === 'none') {
      return null;
    }

    if (decision.kind === 'stored-token') {
      return { kind: 'stored-token' };
    }

    const selection = adapter.findAuthSelection?.() ?? null;

    if (selection === null) {
      throw new Error(`agent '${adapter.id}' decided on a credential without an auth selection`);
    }

    const planned = buildAuthBinding(selection.gateway, selection.profiles);

    if ('problem' in planned) {
      throw new AtcError('auth_binding_invalid', planned.problem.message, {
        agent: adapter.id,
        problem: planned.problem.code,
      });
    }

    if (decision.kind === 'broker') {
      return { kind: 'broker', host: decision.broker, binding: planned.binding };
    }

    return {
      kind: 'routed',
      router: decision.router,
      binding: planned.binding,
      profiles: planned.binding.profiles.flatMap((name) => {
        const profile = selection.profiles.get(name);

        return profile === undefined ? [] : [profile];
      }),
    };
  };

  // A host that holds a binding in any state may hold grants that atc could not confirm gone.
  // Only a rebind or a forget of the host clears them.
  const requireUnboundHost = async (agent: string, hostKey: SessionID): Promise<void> => {
    const binder = callbacks.findAuthBinder();
    const held = binder === null ? null : await binder.readBinding(hostKey);

    if (held !== null) {
      throw new AtcError(
        'auth_rebind_required',
        `agent '${agent}' takes no credential from the target's broker, but its host holds a runtime auth binding; give the agent its auth block back, or forget the session`,
        { agent, state: held.state, problem: 'auth_dropped' },
      );
    }
  };

  const verifyHarnessAuth = async (
    agent: AgentID,
    provider: ExecutionProvider,
    hostKey: SessionID,
    auth: HarnessAuthSetup & { readonly kind: 'broker' },
  ): Promise<VerifiedAuth> => {
    // Two agents on one host that select different profiles would each move the host back to
    // their own binding on every launch, so only a sole agent may rebind.
    const isSoleAgent = registry.sessions.every(
      (other) => other.hostKey !== hostKey || other.agent === agent,
    );

    const credentials = getHostCredentials(provider);

    const rebind =
      credentials.kind === 'broker' && credentials.rebindChangedAuth && isSoleAgent
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
      const adapter = registry.findAdapter(agent);

      if (adapter === null) {
        return;
      }

      requireAuthDecision(adapter, registry.targets.get(target)?.provider ?? {}, target);
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
          throw new AtcError(
            'auth_blocked',
            `the runtime auth of host ${hostKey} is ${held.state}; rebind it to launch again`,
            { host: hostKey, state: held.state },
          );
        }

        return;
      }

      throw new AtcError(
        'auth_binding_mismatch',
        `a sub-session joins the host of session ${hostKey} only under the runtime auth binding that host holds`,
        { host: hostKey, hostBound: held !== null, bound: binding !== null },
      );
    },

    setupHarnessOnHost: async (params) => {
      const adapter = params.adapter;
      const provider = params.provider;
      const id = params.id;
      const hostKey = params.hostKey;
      const target = params.target;
      const options = params.spawnOptions;
      const auth = params.auth;
      const cwd = params.cwd;
      const timer = params.timer;
      const refusal = adapter.findSpawnRefusal?.() ?? null;

      if (refusal !== null) {
        throw refusal;
      }

      if (auth?.kind !== 'broker') {
        await requireUnboundHost(adapter.id, hostKey);
      }

      if (auth?.kind === 'routed') {
        await auth.router.verifyRoutes(auth.profiles);
      }

      if (!provider.remote) {
        await provider.prepareHost({
          host: hostKey,
          daemonID: store.daemonID,
          isIdle: () => harnesses.isHostIdle(hostKey, target),
          timer,
        });

        const local = adapter.planSpawn(options, id);

        if (local.scratch !== undefined && adapter.trustLocalScratch !== undefined) {
          const trust = adapter.trustLocalScratch.bind(adapter);
          const scratch = local.scratch;

          await timer.withStep('scratch-trust', async () => {
            try {
              await trust(scratch);
            } catch (error) {
              throw new AtcError(
                'internal',
                `could not trust the session's scratch folder ${scratch}: ${error instanceof Error ? error.message : String(error)}`,
                { agent: adapter.id },
              );
            }
          });
        }

        return {
          plan: {
            bin: local.bin,
            args: local.args,
            env: local.env ?? {},
            ...(local.scratch === undefined ? {} : { scratch: local.scratch }),
            admission: null,
            heldRevision: null,
          },
          attemptID: null,
        };
      }

      const guest = await readGuestLayout(provider, hostKey);

      const directory = buildGuestSessionDirectory(guest.directory, id);

      const verified =
        auth?.kind === 'broker' && auth.mode === 'verify'
          ? await timer.withStep('auth-binding', () =>
              verifyHarnessAuth(adapter.id, provider, hostKey, auth),
            )
          : null;

      const sessionEnv = provider.sessionEnv ?? {};

      const paths: GuestPaths = {
        atc: guest.atc,
        directory,
        sessionEnv,
        ...(guest.signIn === null ? {} : { signIn: { directory: guest.signIn } }),
        ...(auth === null || auth.kind === 'stored-token'
          ? {}
          : {
              auth: await timer.withStep('auth-plan', () =>
                planGuestAuth(auth, verified?.binding.revision ?? 1),
              ),
            }),
      };

      const plan = planHarnessOnGuest(adapter, options, paths, auth);

      if (plan === null) {
        throw auth === null
          ? buildGuestRefusal(provider.kind, adapter.id, target, guest.atc === null)
          : new AtcError(
              'auth_target_unsupported',
              `agent '${adapter.id}' plans no guest settings to take its credential from the credentials of target '${target}'`,
              { agent: adapter.id, target, problem: 'no_guest_plan' },
            );
      }

      const env = { ...sessionEnv, ...plan.env };

      requireGuestEnv(adapter.id, target, env, auth !== null && auth.kind !== 'stored-token');

      const attemptID =
        auth?.kind === 'broker' && auth.mode === 'create'
          ? await timer.withStep('auth-binding', () =>
              requireAuthBinder().createBinding(auth.host, {
                hostKey,
                target,
                targetIdentity: auth.targetIdentity,
                binding: auth.binding,
              }),
            )
          : null;

      const location = adapter.agentHomeLocation;
      let agentHome: string | undefined;

      try {
        await setupGuest(
          { store, callbacks, harnesses },
          { adapter, provider, hostKey, target, directory, planned: plan.files, timer },
        );

        if (location !== undefined) {
          agentHome = await timer.withStep('agent-home', () =>
            readHostAgentHome(provider, hostKey, location, env),
          );
        }

        if (auth !== null && cwd !== null) {
          await timer.withStep('project-settings', () =>
            self.requireProjectSettings({ adapter, provider, hostKey, target, cwd }),
          );
        }
      } catch (error) {
        if (attemptID !== null || params.isNewHost) {
          await rollback.destroyFailedSpawnHost(provider, id, hostKey, attemptID);
        }

        throw error;
      }

      const admission =
        auth?.kind !== 'broker' || paths.auth === undefined
          ? null
          : { revision: paths.auth.revision, hash: auth.binding.hash, attemptID };

      return {
        plan: {
          bin: plan.bin,
          args: plan.args,
          env,
          ...(plan.scratch === undefined ? {} : { scratch: plan.scratch }),
          ...(agentHome === undefined ? {} : { agentHome }),
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

    requireProjectSettings: (launch) => requireProjectSettings(claims, launch),

    revokeAuth: async (id) => {
      const session = registry.sessions.find((x) => x.id === id);

      if (session === undefined) {
        return false;
      }

      const provider = registry.findProvider(session);

      requireNotRouted(provider);

      await requireAuthBinder().revokeBinding(findHostBroker(provider), session.hostKey);

      return true;
    },

    updateAuth: async (id) => {
      const session = registry.sessions.find((x) => x.id === id);

      if (session === undefined) {
        return null;
      }

      const adapter = registry.findAdapter(session.agent);

      if (adapter === null) {
        throw new AtcError('unsupported_operation', `no adapter for agent '${session.agent}'`, {
          agent: session.agent,
        });
      }

      const provider = registry.requireExecution(session, 'spawn').provider;

      requireNotRouted(provider);

      const auth = resolveHarnessAuth(adapter, provider, session.target);

      if (auth?.kind !== 'broker') {
        throw new AtcError(
          'unsupported_operation',
          `agent '${session.agent}' takes no credential from the target's broker`,
          { agent: session.agent, problem: 'no_auth_selection' },
        );
      }

      const revision = await requireAuthBinder().updateBinding(
        auth.host,
        session.hostKey,
        auth.binding,
      );

      harnesses.authRevisions.set(session.hostKey, revision);

      // A running harness keeps the settings it launched with, so a new revision only applies at
      // its next launch.
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
