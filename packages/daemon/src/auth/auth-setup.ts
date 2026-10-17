import { posix } from 'node:path';
import type { AgentID, SessionID, StepTimer } from '@atc/core';
import { buildTarArchive, isBrokerVariable } from '@atc/core';
import type {
  AgentAdapter,
  CredentialBroker,
  ExecutionProvider,
  GuestPaths,
  GuestSpawnPlan,
  HarnessSpec,
  SpawnOptions,
  SpawnPlan,
} from '@atc/plugin-api';
import { DaemonError } from '@atc/protocol/wire';
import type { FleetStore, RuntimeAuthBinding } from '@atc/store';
import type { SessionFleetWriter } from '../fleet/session-fleet-writer';
import type { HostDirClaims } from '../sessions/host-dir-claims';
import type { SessionCallbacks } from '../sessions/session-callbacks';
import type { SessionHarnesses } from '../sessions/session-harnesses';
import type { SessionRegistry } from '../sessions/session-registry';
import type { SpawnRollback } from '../sessions/spawn-rollback';
import { REPOSITORY_ENV_UNSET_ARGV } from '../workspace/repository-env-unset-argv';
import { buildAuthBinding } from './build-auth-binding';
import type { AuthBinding } from './build-auth-binding';
import { formatAuthNotice } from './format-auth-notice';
import { loadOAuthStates } from './load-oauth-states';
import type { RuntimeAuthBinder } from './runtime-auth-binder';

// prints `<path>\0F<base64>\0` per path that exists: start files in the resolved dir, then root
// files there, in every dir above and in the worktree's main checkout; `U` replaces `F<base64>`
// for anything not a readable regular file within the size cap, and a missing dir exits 3
export const READ_PROJECT_SETTINGS_SCRIPT = `cd -P -- "$1" 2>/dev/null || exit 3; shift; d=$(pwd -P)
emit() {
  [ -e "$1" ] || [ -L "$1" ] || return 0
  if [ -f "$1" ] && n=$(wc -c < "$1" 2>/dev/null) && [ "$n" -le 1048576 ] && b=$(base64 -w0 -- "$1" 2>/dev/null); then printf '%s\\0F%s\\0' "$1" "$b"; else printf '%s\\0U\\0' "$1"; fi
}
while [ "$#" -gt 0 ] && [ "$1" != -- ]; do emit "\${d%/}/$1"; shift; done; [ "$#" -gt 0 ] && shift
m=$(git -c safe.directory='*' -c core.fsmonitor=false rev-parse --path-format=absolute --git-common-dir 2>/dev/null) && m=\${m%/.git} || m=
for n in "$@"; do p=$d; while :; do emit "\${p%/}/$n"; [ "$p" = / ] && break; p=\${p%/*}; [ -n "$p" ] || p=/; done; [ -z "$m" ] || emit "\${m%/}/$n"; done
exit 0`;

const ABSENT_DIR_EXIT = 3;

// The largest settings file atc reads.
const MAX_SETTINGS_BYTES = 1_048_576;

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
  readonly callbacks: Pick<SessionCallbacks, 'onEvent' | 'log' | 'getAuthBinder'>;
}

export class AuthSetup {
  private readonly registry: AuthSetupDeps['registry'];

  private readonly fleet: AuthSetupDeps['fleet'];

  private readonly claims: AuthSetupDeps['claims'];

  private readonly harnesses: AuthSetupDeps['harnesses'];

  private readonly rollback: AuthSetupDeps['rollback'];

  private readonly store: AuthSetupDeps['store'];

  private readonly callbacks: AuthSetupDeps['callbacks'];

  constructor(deps: AuthSetupDeps) {
    this.registry = deps.registry;
    this.fleet = deps.fleet;
    this.claims = deps.claims;
    this.harnesses = deps.harnesses;
    this.rollback = deps.rollback;
    this.store = deps.store;
    this.callbacks = deps.callbacks;
  }

  // throws before a spawn or an adopt does any work, for an agent that needs a broker the
  // target does not reach or the daemon cannot bind
  requireAgentTarget(agent: AgentID, target: string): void {
    const selection = this.registry.findAdapter(agent)?.findAuthSelection?.() ?? null;

    if (selection === null) {
      return;
    }

    const host = this.registry.targets.get(target)?.provider?.brokerAuth;

    if (host === undefined && !selection.brokerRequired) {
      return;
    }

    if (host === undefined || this.callbacks.getAuthBinder() === null) {
      throw buildBrokerTargetRefusal(agent, target);
    }
  }

  // null when the agent may start on this provider under the host's own sign-in; an agent that
  // starts only behind the broker is refused instead, so it never falls back to a local start
  resolveHarnessAuth(
    adapter: AgentAdapter,
    provider: ExecutionProvider,
    target: string,
  ): HarnessAuth | null {
    const selection = adapter.findAuthSelection?.() ?? null;

    if (selection === null) {
      return null;
    }

    const host = provider.brokerAuth;

    if (host === undefined && !selection.brokerRequired) {
      return null;
    }

    if (host === undefined || this.callbacks.getAuthBinder() === null) {
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
  }

  // A sub-session joins its parent's host only under the binding that host
  // holds: both without runtime auth, or both bound to the same hash, and
  // then only while that binding is ready.
  async requireSharedBinding(hostKey: SessionID, binding: AuthBinding | null): Promise<void> {
    const found = await this.callbacks.getAuthBinder()?.findBinding(hostKey);

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
  }

  // every refusal comes before the harness starts; a failure once the host is readied takes
  // back the binding this call created, or destroys a spawn's own new host
  async setupHarnessOnHost(
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
  ): Promise<{ readonly plan: HarnessPlan; readonly attemptID: string | null }> {
    const refusal = adapter.findSpawnRefusal?.() ?? null;

    if (refusal !== null) {
      throw refusal;
    }

    if (auth === null) {
      await this.requireUnboundHost(adapter.id, hostKey);
    }

    if (!provider.remote) {
      await provider.prepareHost({
        host: hostKey,
        daemonID: this.store.daemonID,
        isIdle: () => this.harnesses.isHostIdle(hostKey, target),
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

    const guest = provider.guest ?? { dir: '/tmp/atc', atc: null };
    const dir = `${guest.dir}/sessions/${id}`;

    // A launch on a bound host verifies the binding before it plans, since
    // a target that rebinds a changed selection moves the binding to the
    // revision the plan then launches under.
    const verified =
      auth?.mode === 'verify'
        ? await timer.withStep('auth-binding', () =>
            this.verifyHarnessAuth(adapter.id, provider, hostKey, auth),
          )
        : null;

    const paths: GuestPaths =
      auth === null
        ? { atc: guest.atc, dir }
        : {
            atc: guest.atc,
            dir,
            auth: await timer.withStep('auth-plan', () =>
              this.planGuestAuth(auth, verified?.binding.revision ?? 1),
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
            this.requireAuthBinder().createBinding(auth.host, {
              hostKey,
              target,
              targetIdentity: auth.targetIdentity,
              binding: auth.binding,
            }),
          )
        : null;

    try {
      await this.setupGuest(adapter, provider, hostKey, target, dir, plan.files, timer);

      if (auth !== null && cwd !== null) {
        await timer.withStep('project-settings', () =>
          this.requireProjectSettings(adapter, provider, hostKey, target, cwd),
        );
      }
    } catch (error) {
      if (attemptID !== null || isNewHost) {
        await this.rollback.destroyFailedSpawnHost(provider, id, hostKey, attemptID);
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
  }

  // The part of a harness spec that keeps a launch behind the broker: the
  // requirement impd checks, and the admission each request needs from
  // the host's binding when it goes out.
  buildBrokerSpec(
    hostKey: SessionID,
    admission: HarnessPlan['admission'],
  ): Pick<HarnessSpec, 'requireBroker' | 'admit'> {
    if (admission === null) {
      return {};
    }

    const binder = this.requireAuthBinder();

    return {
      requireBroker: true,
      admit: (kind, send) => binder.withLaunchAdmission(hostKey, admission, kind, send),
    };
  }

  // A launch without runtime auth never starts on a host that holds a
  // binding, whatever its state: the imp may hold grants atc could not
  // confirm gone, and only a rebind or a forget of the host clears it.
  private async requireUnboundHost(agent: string, hostKey: SessionID): Promise<void> {
    const binder = this.callbacks.getAuthBinder();
    const held = binder === null ? null : await binder.findBinding(hostKey);

    if (held !== null) {
      throw new DaemonError(
        'auth_rebind_required',
        `agent '${agent}' takes no credential from impd's broker, but its host holds a runtime auth binding; give the agent its auth block back, or forget the session`,
        { agent, state: held.state, problem: 'auth_dropped' },
      );
    }
  }

  // The binding revision and placeholders a guest plan behind the broker
  // launches under, with the sign-in state impd lists for each oauth
  // secret the binding holds.
  private async planGuestAuth(
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

  private async verifyHarnessAuth(
    agent: AgentID,
    provider: ExecutionProvider,
    hostKey: SessionID,
    auth: HarnessAuthSetup,
  ): Promise<VerifiedAuth> {
    // only a host whose every session runs this agent rebinds: two agents that select
    // different profiles would each move the host back on their own launches
    const isSoleAgent = this.registry.sessions.every(
      (other) => other.hostKey !== hostKey || other.agent === agent,
    );

    const rebind =
      provider.rebindChangedAuth === true && isSoleAgent
        ? {
            log: (line: string) => {
              this.callbacks.log(line);
            },
          }
        : null;

    const binder = this.requireAuthBinder();

    const held = await binder.findBinding(hostKey);
    const row = await binder.verifyBinding(auth.host, hostKey, auth.binding, rebind);

    this.harnesses.authRevisions.set(hostKey, row.revision);

    const older = this.registry.sessions.filter(
      (other) =>
        other.hostKey === hostKey && other.pty !== null && this.harnesses.isAuthOutdated(other),
    );

    for (const other of older) {
      other.lastMsg = formatAuthNotice(row.revision);

      this.callbacks.onEvent('state', other);
    }

    if (older.length > 0) {
      this.fleet.emitChange();
    }

    return { binding: row, heldRevision: held?.revision ?? row.revision };
  }

  // Readies a remote host and the files a guest plan reads there, after
  // the agent's sign-in check.
  private async setupGuest(
    adapter: AgentAdapter,
    provider: ExecutionProvider,
    hostKey: SessionID,
    target: string,
    dir: string,

    planned: GuestSpawnPlan['files'],
    timer: StepTimer,
  ): Promise<void> {
    await provider.prepareHost({
      host: hostKey,
      daemonID: this.store.daemonID,
      installATC: adapter.planGuestSpawn !== undefined,
      log: this.callbacks.log,
      isIdle: () => this.harnesses.isHostIdle(hostKey, target),
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
        provider.transferArchive(buildTarArchive(files), dir, hostKey),
      );
    }
  }

  async requireProjectSettings(
    adapter: AgentAdapter,
    provider: ExecutionProvider,
    hostKey: SessionID,
    target: string,
    cwd: string,
  ): Promise<void> {
    const check = adapter.planProjectSettingsCheck?.();

    if (check === undefined) {
      return;
    }

    // The host resolves the directory as given, since a lexical join would
    // drop a parent step after a symlink that the host follows.
    const home = posix.isAbsolute(cwd)
      ? null
      : await this.claims.resolveHostHome(provider, hostKey);

    const dir = home === null ? cwd : `${home}/${cwd}`;

    const found = await provider.runCommand({
      argv: [
        ...REPOSITORY_ENV_UNSET_ARGV,
        'sh',
        '-c',
        READ_PROJECT_SETTINGS_SCRIPT,
        'sh',
        dir,
        ...check.files,
        '--',
        ...check.rootFiles,
      ],
      cwd: '/',
      host: hostKey,
    });

    if (found.exitCode === ABSENT_DIR_EXIT) {
      return;
    }

    if (found.exitCode !== 0) {
      throw this.buildUnreadableSettingsRefusal(adapter.id, target, dir);
    }

    for (const [path, read] of collectSettingsReads(found.stdout)) {
      const content = read === null ? null : Buffer.from(read, 'base64');

      // a file the host holds but cannot read as a settings file refuses, since what the agent
      // would take from it is unknown
      if (content === null || content.byteLength > MAX_SETTINGS_BYTES) {
        throw this.buildUnreadableSettingsRefusal(adapter.id, target, path);
      }

      const refusal = check.findRefusal(path, new TextDecoder().decode(content));

      if (refusal !== null) {
        throw new DaemonError(refusal.code, refusal.message, { ...refusal.data, target });
      }
    }
  }

  private buildUnreadableSettingsRefusal(agent: string, target: string, path: string): DaemonError {
    return new DaemonError(
      'auth_target_unsupported',
      `agent '${agent}' signs in through impd's broker on target '${target}', but atc cannot read ${path} there as a settings file to check it for settings that would override that sign-in`,
      { agent, target, problem: 'project_settings_unreadable', file: path },
    );
  }

  // launches on the host stay blocked until a rebind; a running harness keeps running while
  // impd fails its later requests
  async revokeAuth(id: SessionID): Promise<boolean> {
    const s = this.registry.sessions.find((x) => x.id === id);

    if (s === undefined) {
      return false;
    }

    await this.requireAuthBinder().revokeBinding(
      this.registry.findProvider(s)?.brokerAuth ?? null,
      s.hostKey,
    );

    return true;
  }

  async updateAuth(id: SessionID): Promise<AuthRebound | null> {
    const s = this.registry.sessions.find((x) => x.id === id);

    if (s === undefined) {
      return null;
    }

    const adapter = this.registry.findAdapter(s.agent);

    if (adapter === null) {
      throw new DaemonError('unsupported_operation', `no adapter for agent '${s.agent}'`, {
        agent: s.agent,
      });
    }

    const provider = this.registry.requireExecution(s, 'spawn').provider;
    const auth = this.resolveHarnessAuth(adapter, provider, s.target);

    if (auth === null) {
      throw new DaemonError(
        'unsupported_operation',
        `agent '${s.agent}' takes no credential from impd's broker`,
        { agent: s.agent, problem: 'no_auth_selection' },
      );
    }

    const revision = await this.requireAuthBinder().updateBinding(
      auth.host,
      s.hostKey,
      auth.binding,
    );

    this.harnesses.authRevisions.set(s.hostKey, revision);

    // a harness keeps the settings it launched with, so each one under an older revision shows
    // that the new one applies at its next launch
    const pending = this.registry.sessions.filter(
      (other) => other.hostKey === s.hostKey && this.harnesses.isAuthOutdated(other),
    );

    for (const other of pending) {
      other.lastMsg = formatAuthNotice(revision);

      this.callbacks.onEvent('state', other);
    }

    if (pending.length > 0) {
      this.fleet.emitChange();
    }

    return { revision, restartPending: pending.map((other) => other.id) };
  }

  requireAuthBinder(): RuntimeAuthBinder {
    const binder = this.callbacks.getAuthBinder();

    if (binder === null) {
      throw new DaemonError('unsupported_operation', 'this daemon binds no runtime auth', {
        problem: 'no_auth_binder',
      });
    }

    return binder;
  }
}

// An agent that takes its credential from impd's broker on a target that
// reaches none.
function buildBrokerTargetRefusal(agent: string, target: string): DaemonError {
  return new DaemonError(
    'auth_target_unsupported',
    `agent '${agent}' takes its credential from impd's broker, which target '${target}' does not reach`,
    { agent, target },
  );
}

// An agent that plans no remote spawn: for want of an atc inside the host
// when the host has none, or because the agent never runs remotely.
function buildGuestRefusal(
  provider: string,
  agent: string,
  target: string,
  hasNoATC: boolean,
): DaemonError {
  return hasNoATC
    ? new DaemonError(
        'unsupported_operation',
        `agent '${agent}' cannot run on target '${target}': its host has no atc to report through; run a compiled atc daemon on Linux, or set the target's guestATC to an atc installed in its image`,
        { provider, agent, problem: 'no_guest_atc' },
      )
    : new DaemonError(
        'unsupported_operation',
        `agent '${agent}' cannot run on a remote target such as '${target}'`,
        { provider, agent, problem: 'remote_unsupported' },
      );
}

// A guest plan's variables start the harness as they are, so none may be
// one atc sets for its own reporting, and behind the broker none may be a
// proxy or CA variable that would route around the broker.
function requireGuestEnv(
  agent: string,
  target: string,
  env: Readonly<Record<string, string>>,
  behindBroker: boolean,
): void {
  const own = Object.keys(env).find((key) => key.startsWith('ATC_'));

  if (own !== undefined) {
    throw new Error(`agent '${agent}' plans ${own}, which atc sets for the harness itself`);
  }

  const broker = behindBroker ? Object.keys(env).find((key) => isBrokerVariable(key)) : undefined;

  if (broker !== undefined) {
    throw new DaemonError(
      'auth_target_unsupported',
      `agent '${agent}' plans ${broker} on target '${target}', which would route around impd's broker`,
      { agent, target, problem: 'guest_env_conflict', variable: broker },
    );
  }
}

// Each path the settings read printed, once and in the order it first
// printed it, with the file's content in base64, or null for a path it
// could not read as a settings file.
function collectSettingsReads(stdout: string): Map<string, string | null> {
  const fields = stdout.split('\0');

  const reads = new Map<string, string | null>();

  for (let i = 0; i + 1 < fields.length; i += 2) {
    const path = fields[i] ?? '';
    const read = fields[i + 1] ?? '';
    const content = read.startsWith('F') ? read.slice(1) : null;

    if (path !== '' && !reads.has(path)) {
      reads.set(path, content);
    }
  }

  return reads;
}
