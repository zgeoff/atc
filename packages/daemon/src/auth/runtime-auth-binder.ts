import { randomUUID } from 'node:crypto';
import { getSettledValue, makeKeyedLock, systemClock } from '@atc/core';
import type { SessionID } from '@atc/core';
import type { BrokerHost, CredentialBroker, LaunchTicket } from '@atc/plugin-api';
import { CredentialBrokerError, EffectRemainsError } from '@atc/plugin-api';
import { DaemonError } from '@atc/protocol/wire';
import type { RuntimeAuthBinding, RuntimeAuthGrant, StateStore } from '@atc/store';
import { z } from 'zod';
import { BrokerAuthorityError } from './broker-authority-error';
import type { AuthBinding } from './build-auth-binding';
import { collectSecretRuleMismatches } from './collect-secret-rule-mismatches';
import { planBindingReconcile } from './plan-binding-reconcile';
import { planBindingVerify } from './plan-binding-verify';
import { planLaunchAdmission } from './plan-launch-admission';
import { planReadyUpdate } from './plan-ready-update';
import { planRebindStart } from './plan-rebind-start';
import { verifyBrokerAuthority } from './verify-broker-authority';
import { verifyCleanupAuthority } from './verify-cleanup-authority';

/**
 * The store calls the binder makes: a host's binding and its grant rows.
 */
type RuntimeAuthStore = Pick<
  StateStore,
  | 'createAuthBinding'
  | 'updateAuthBinding'
  | 'findAuthBinding'
  | 'collectAuthBindings'
  | 'upsertAuthGrant'
  | 'collectAuthGrants'
  | 'removeAuthBinding'
>;

// The host a fresh spawn provisions: its key, the target and identity it
// runs on, and the binding its agent asks for.
interface BindingRequest {
  readonly hostKey: SessionID;
  readonly target: string;
  readonly targetIdentity: string;
  readonly binding: AuthBinding;
}

// How a verify moves a binding whose auth selection changed to the current
// one: the log each rebind writes its line to.
interface ChangedAuthRebind {
  readonly log: (line: string) => void;
}

// What a launch was planned under: the binding's revision and hash, and
// the spawn attempt still provisioning the host, or null for a launch on a
// host already ready.
interface LaunchAdmission {
  readonly revision: number;
  readonly hash: string;
  readonly attemptID: string | null;
}

/**
 * Binds a host's runtime auth through impd's credential broker and keeps
 * the binding's record in the store, one host at a time: every call on a
 * host waits for the one before it on that host.
 *
 * A spawn creates the binding: the full gate, then the record, then a new
 * imp, then each grant, each step recorded before the next. A resume, a
 * restore, and a sub-session joining the host verify it: the full gate,
 * the imp's identity, and the exact grant set, and nothing is granted
 * again, unless the launch's target rebinds a changed selection. A rebind
 * moves the binding to a new revision. A revoke and a
 * forget first record the block that stops every launch, then check only
 * that the token may manage the recorded imp and that the imp is still
 * the one recorded, never a secret's rules or a complete grant set.
 * Every harness start and attach is admitted under the same lock, so a
 * block recorded before the admission refuses it. Nothing here falls back
 * to a broader token or to a local launch.
 */
export class RuntimeAuthBinder {
  private readonly store: RuntimeAuthStore;

  private readonly now: () => number;

  // Runs each call on a host after the one before it on that host.
  private readonly withHostLock = makeKeyedLock();

  // The admissions on each host whose request has not gone out yet. A
  // revoke, a rebind or a forget cancels them before it writes anything,
  // so a request still opening its connection closes it unsent.
  private readonly pending = new Map<SessionID, Set<{ refusal: DaemonError | null }>>();

  constructor(store: RuntimeAuthStore, now: () => number = systemClock.now) {
    this.store = store;
    this.now = now;
  }

  findBinding(hostKey: SessionID): Promise<RuntimeAuthBinding | null> {
    return this.store.findAuthBinding(hostKey);
  }

  /**
   * Provisions a fresh host for a spawn and returns the attempt's id. It
   * writes nothing until the gate passes, refuses an imp that already
   * holds the name or any grant, and records the imp's id as soon as impd
   * creates it. A refusal after the record exists takes back what this
   * attempt made before it rejects, and a take-back that cannot be
   * confirmed rejects with an effect that remains.
   */
  createBinding(host: CredentialBroker, request: BindingRequest): Promise<string> {
    return this.withHostLock(request.hostKey, async () => {
      const impName = host.getHostName(request.hostKey);
      const binding = request.binding;

      // The read of the name goes out with the gate's reads, and the gate
      // still refuses first.
      const [gate, existing] = await Promise.allSettled([
        verifyGate(host, impName, binding),
        host.readHost(impName),
      ]);

      try {
        getSettledValue(gate);
      } catch (error) {
        throw toAuthRefusal(error);
      }

      const attemptID = randomUUID();

      await this.store.createAuthBinding(
        {
          hostKey: request.hostKey,
          target: request.target,
          targetIdentity: request.targetIdentity,
          impName,
          bindingHash: binding.hash,
          bindingJSON: JSON.stringify(binding),
          attemptID,
        },
        this.now(),
      );

      try {
        await this.createImpAndGrants(host, request.hostKey, impName, binding, attemptID, existing);
      } catch (error) {
        await this.removeAttemptLocked(host, request.hostKey, attemptID);

        throw toAuthRefusal(error);
      }

      return attemptID;
    });
  }

  /**
   * Records a provisioned host ready once its harness started, unless a
   * revoke or another attempt has moved the binding on since.
   */
  async updateReady(hostKey: SessionID, attemptID: string): Promise<void> {
    await this.withHostLock(hostKey, async () => {
      const row = await this.store.findAuthBinding(hostKey);

      if (planReadyUpdate(row, attemptID) === 'ready') {
        await this.store.updateAuthBinding(hostKey, { state: 'ready' }, this.now());
      }
    });
  }

  /**
   * Checks a host's binding before a harness launches on it again. Every
   * check reads, so a refusal changes nothing: the binding must be ready,
   * the current binding must hash as the one recorded, the gate must pass,
   * each secret must hold exactly the bound rules, the imp under the name
   * must be the one recorded, and impd must hold exactly the bound grants.
   * Resolves to the binding.
   *
   * Given a rebind, a binding whose hash alone differs from the current
   * one moves to it instead of refusing: the imp must still be the one
   * recorded and hold exactly the grants both bindings keep, and then the
   * rebind's own steps run, which cancel no admission of another harness
   * on the host. A failed rebind refuses and leaves the binding blocked as
   * one, and the next launch given a rebind tries it again. Each rebind
   * logs one line with the revisions and the profiles it adds and drops.
   */
  verifyBinding(
    host: CredentialBroker,
    hostKey: SessionID,
    binding: AuthBinding,
    rebind: ChangedAuthRebind | null = null,
  ): Promise<RuntimeAuthBinding> {
    return this.withHostLock(hostKey, async () => {
      const row = await this.store.findAuthBinding(hostKey);

      if (row === null) {
        throw new DaemonError(
          'auth_blocked',
          `host ${hostKey} has no runtime auth binding, so nothing may launch on it with auth`,
          { host: hostKey, state: null },
        );
      }

      const isChanged = row.bindingHash !== binding.hash;
      const plan = planBindingVerify(row, isChanged, rebind !== null);

      if (plan === 'blocked') {
        throw new DaemonError(
          'auth_blocked',
          `the runtime auth of host ${hostKey} is ${row.state}; rebind it to launch again`,
          { host: hostKey, state: row.state },
        );
      }

      if (plan === 'rebind' && rebind !== null) {
        return this.updateChangedBinding(host, row, binding, rebind);
      }

      if (isChanged) {
        throw new DaemonError(
          'auth_rebind_required',
          `the auth profiles host ${hostKey} uses changed since it was bound; rebind it to adopt them`,
          { host: hostKey, revision: row.revision, problem: 'auth_selection_changed' },
        );
      }

      // The imp and its grants are read with the gate's reads, and each
      // check still refuses in the gate, imp, grants order.
      const [gate, impRead, grantsRead] = await Promise.allSettled([
        verifyGate(host, row.impName, binding),
        tryReadImp(host, row.impName),
        tryReadGrants(host, row.impName),
      ]);

      try {
        getSettledValue(gate);
      } catch (error) {
        throw toAuthRefusal(error);
      }

      const imp = getSettledValue(impRead);

      if (imp === null || imp.id !== row.impID || row.impName !== host.getHostName(hostKey)) {
        throw new DaemonError(
          'auth_runtime_mismatch',
          `imp ${row.impName} is no longer the imp host ${hostKey} was bound to`,
          { host: hostKey, imp: row.impName, recordedID: row.impID, actualID: imp?.id ?? null },
        );
      }

      const held = getSettledValue(grantsRead);
      const bound = binding.secrets.map((secret) => secret.secret);
      const missing = bound.filter((secret) => !held.includes(secret));
      const extra = held.filter((secret) => !bound.includes(secret));

      if (missing.length > 0) {
        throw new DaemonError(
          'auth_grant_missing',
          `imp ${row.impName} no longer holds ${missing.join(', ')}; atc never grants it again on its own, so rebind the host`,
          { host: hostKey, missing },
        );
      }

      if (extra.length > 0) {
        throw new DaemonError(
          'auth_grants_mismatch',
          `imp ${row.impName} holds ${extra.join(', ')}, which its binding does not grant`,
          { host: hostKey, extra },
        );
      }

      return row;
    });
  }

  // Moves a binding whose selection changed to the current one, under the
  // host's lock: the imp's identity and the grants both bindings keep are
  // checked first, so a grant lost outside atc still refuses rather than
  // being granted again. A failed rebind first takes back the grants its
  // attempt added, as a daemon start does, so one whose removal failed
  // before does not read as a grant the binding never made.
  private async updateChangedBinding(
    host: CredentialBroker,
    row: RuntimeAuthBinding,
    binding: AuthBinding,
    rebind: ChangedAuthRebind,
  ): Promise<RuntimeAuthBinding> {
    const imp = await tryReadImp(host, row.impName);

    if (imp === null || imp.id !== row.impID || row.impName !== host.getHostName(row.hostKey)) {
      throw new DaemonError(
        'auth_runtime_mismatch',
        `imp ${row.impName} is no longer the imp host ${row.hostKey} was bound to`,
        { host: row.hostKey, imp: row.impName, recordedID: row.impID, actualID: imp?.id ?? null },
      );
    }

    if (row.state === 'rebind_failed' && row.rebind !== null) {
      await this.removeRebindGrants(host, row.hostKey, row.impName, row.rebind.attemptID);
    }

    const held = await tryReadGrants(host, row.impName);

    const recorded = parseBoundSecrets(row.bindingJSON);

    const bound = new Set(binding.secrets.map((secret) => secret.secret));

    const missing = recorded.filter((secret) => bound.has(secret) && !held.includes(secret));
    const extra = held.filter((secret) => !recorded.includes(secret));

    if (missing.length > 0) {
      throw new DaemonError(
        'auth_grant_missing',
        `imp ${row.impName} no longer holds ${missing.join(', ')}; atc never grants it again on its own, so rebind the host`,
        { host: row.hostKey, missing },
      );
    }

    if (extra.length > 0) {
      throw new DaemonError(
        'auth_grants_mismatch',
        `imp ${row.impName} holds ${extra.join(', ')}, which its binding does not grant`,
        { host: row.hostKey, extra },
      );
    }

    const revision = await this.updateBindingLocked(host, row, binding);

    const before = parseBoundProfiles(row.bindingJSON);
    const added = binding.profiles.filter((profile) => !before.includes(profile));
    const removed = before.filter((profile) => !binding.profiles.includes(profile));

    rebind.log(
      `atc: rebound the runtime auth of host ${row.hostKey} from revision ${String(row.revision)} to revision ${String(revision)} (added profiles: ${formatNames(added)}; removed profiles: ${formatNames(removed)})`,
    );

    return this.requireBinding(row.hostKey);
  }

  /**
   * Admits one start or attach of a harness on a host, by calling send,
   * which hands the request to impd's client, under the host's lock and
   * only while the binding is still launchable: ready, or still being
   * provisioned by the attempt that launches. A start also needs the
   * revision and hash its launch was planned under. send gets a ticket
   * whose check the client runs once its connection to impd opens, just
   * before the request goes out: null lets it go, and the refusal of a
   * revoke, a rebind or a forget that came first stops it unsent. A
   * connection that ends before it opens releases the ticket. A revoke, a rebind
   * or a forget therefore either refuses the admission or cancels it, or
   * comes after the request went out. The lock is held only for one read
   * and the handoff, never across the network.
   */
  withLaunchAdmission(
    hostKey: SessionID,
    admission: LaunchAdmission,
    kind: 'start' | 'attach',
    send: (ticket: LaunchTicket) => void,
  ): Promise<void> {
    return this.withHostLock(hostKey, async () => {
      const row = await this.store.findAuthBinding(hostKey);

      if (row === null || planLaunchAdmission(row, admission.attemptID) === 'blocked') {
        throw new DaemonError(
          'auth_blocked',
          `the runtime auth of host ${hostKey} is ${row?.state ?? 'gone'}; nothing launches on it until a rebind`,
          { host: hostKey, state: row?.state ?? null },
        );
      }

      if (
        kind === 'start' &&
        (row.revision !== admission.revision || row.bindingHash !== admission.hash)
      ) {
        throw new DaemonError(
          'auth_rebind_required',
          `the runtime auth of host ${hostKey} moved to revision ${String(row.revision)} after this launch was planned`,
          { host: hostKey, revision: row.revision, problem: 'revision_moved' },
        );
      }

      const ticket: { refusal: DaemonError | null } = { refusal: null };
      const tickets = this.pending.get(hostKey) ?? new Set();

      tickets.add(ticket);
      this.pending.set(hostKey, tickets);

      const release = () => {
        tickets.delete(ticket);

        if (tickets.size === 0 && this.pending.get(hostKey) === tickets) {
          this.pending.delete(hostKey);
        }
      };

      send({
        check: () => {
          release();

          return ticket.refusal;
        },
        release,
      });
    });
  }

  // How many admitted requests on a host have not gone out or ended yet.
  countPendingAdmissions(hostKey: SessionID): number {
    return this.pending.get(hostKey)?.size ?? 0;
  }

  // Stops every admitted request on a host that has not gone out yet,
  // with the block the caller is about to record.
  private revokeAdmissions(hostKey: SessionID, state: string): void {
    const tickets = this.pending.get(hostKey);

    this.pending.delete(hostKey);

    for (const ticket of tickets ?? []) {
      ticket.refusal = new DaemonError(
        'auth_blocked',
        `the runtime auth of host ${hostKey} is ${state}; nothing launches on it until a rebind`,
        { host: hostKey, state },
      );
    }
  }

  /**
   * Takes back what one spawn attempt made: the imp, with every grant on
   * it, but only an imp this attempt created whose id impd still shows
   * under the name, and then the record. An imp atc cannot tell apart from
   * one it did not make is left alone, and so is any attempt but the one
   * given. Rejects with an effect that remains when it cannot confirm the
   * imp gone, leaving the binding pending its take-back.
   */
  async removeAttempt(
    host: CredentialBroker,
    hostKey: SessionID,
    attemptID: string,
  ): Promise<void> {
    await this.withHostLock(hostKey, () => this.removeAttemptLocked(host, hostKey, attemptID));
  }

  /**
   * Withdraws every grant of a host's binding. The block that stops every
   * launch is written first, even when impd cannot be reached; a grant impd
   * no longer holds counts as revoked; a running harness keeps running and
   * impd fails its later requests. Rejects with `auth_revocation_pending`
   * when any grant cannot be confirmed gone.
   */
  async revokeBinding(host: CredentialBroker | null, hostKey: SessionID): Promise<void> {
    await this.withHostLock(hostKey, async () => {
      this.revokeAdmissions(hostKey, 'revocation_pending');

      const row = await this.requireBinding(hostKey);

      await this.store.updateAuthBinding(hostKey, { state: 'revocation_pending' }, this.now());

      const pending = await this.revokeGrants(host, row);

      if (pending.length > 0) {
        throw buildRevocationPending(hostKey, pending);
      }

      const at = this.now();

      await this.store.updateAuthBinding(hostKey, { state: 'revoked', revokedAt: at }, at);
    });
  }

  /**
   * Moves a host's binding to the current binding at the next revision:
   * the full gate on the new binding and the imp's identity first, then
   * each newly bound grant, then the removal of each grant the new binding
   * drops. A failure after the attempt starts removes only the grants this
   * attempt added, restores nothing, never destroys the imp, and leaves the
   * binding at its old revision, blocked as a failed rebind until a retry.
   * Resolves to the new revision.
   */
  updateBinding(host: CredentialBroker, hostKey: SessionID, binding: AuthBinding): Promise<number> {
    return this.withHostLock(hostKey, async () => {
      this.revokeAdmissions(hostKey, 'provisioning');

      const row = await this.requireBinding(hostKey);

      return this.updateBindingLocked(host, row, binding);
    });
  }

  // The rebind's own steps on a binding read under the host's lock, which
  // leave the admissions on the host to the caller.
  private async updateBindingLocked(
    host: CredentialBroker,
    row: RuntimeAuthBinding,
    binding: AuthBinding,
  ): Promise<number> {
    const hostKey = row.hostKey;

    if (planRebindStart(row) === 'blocked') {
      throw new DaemonError(
        'auth_blocked',
        `the runtime auth of host ${hostKey} is ${row.state}, which a rebind cannot move on from`,
        { host: hostKey, state: row.state },
      );
    }

    if (row.impID === null) {
      throw new DaemonError(
        'auth_runtime_mismatch',
        `host ${hostKey} never recorded its imp, so atc cannot rebind it`,
        { host: hostKey, imp: row.impName, recordedID: null, actualID: null },
      );
    }

    try {
      await verifyGate(host, row.impName, binding);

      const imp = await verifyCleanupAuthority(host, { name: row.impName, id: row.impID });

      if (imp === null) {
        throw new BrokerAuthorityError(
          'auth_runtime_mismatch',
          `imp ${row.impName} is gone, so atc cannot rebind it`,
          { imp: row.impName, recordedID: row.impID, actualID: null },
        );
      }
    } catch (error) {
      throw toAuthRefusal(error);
    }

    const revision = row.revision + 1;
    const attemptID = randomUUID();
    const bindingJSON = JSON.stringify(binding);

    await this.store.updateAuthBinding(
      hostKey,
      {
        state: 'provisioning',
        rebind: { revision, bindingHash: binding.hash, bindingJSON, attemptID },
      },
      this.now(),
    );

    try {
      await this.applyRebindGrants(host, row, binding, revision, attemptID);
    } catch (error) {
      await this.removeRebindGrants(host, hostKey, row.impName, attemptID);
      await this.store.updateAuthBinding(hostKey, { state: 'rebind_failed' }, this.now());

      throw toAuthRefusal(error);
    }

    await this.store.updateAuthBinding(
      hostKey,
      {
        state: 'ready',
        revision,
        bindingHash: binding.hash,
        bindingJSON,
        attemptID,
        rebind: null,
      },
      this.now(),
    );

    return revision;
  }

  /**
   * Destroys a bound host's imp for a forget and drops its record, and
   * resolves false when the host has no binding, which leaves the destroy
   * to the caller. The block is written first; only an imp impd still
   * shows under the recorded id is destroyed, and the record goes once
   * impd shows no imp under the name. Never deletes a secret.
   */
  forgetBinding(host: CredentialBroker | null, hostKey: SessionID): Promise<boolean> {
    return this.withHostLock(hostKey, async () => {
      this.revokeAdmissions(hostKey, 'revocation_pending');

      const row = await this.store.findAuthBinding(hostKey);

      if (row === null) {
        return false;
      }

      await this.store.updateAuthBinding(hostKey, { state: 'revocation_pending' }, this.now());

      if (host === null) {
        throw buildRevocationPending(hostKey, ['(imp unreachable)']);
      }

      try {
        assertRecordedImpName(host, row);

        const imp =
          row.impID === null
            ? await tryReadImp(host, row.impName)
            : await verifyCleanupAuthority(host, { name: row.impName, id: row.impID });

        if (imp !== null && row.impID === null) {
          throw new BrokerAuthorityError(
            'auth_runtime_mismatch',
            `imp ${row.impName} exists, but host ${hostKey} never recorded its id`,
            { imp: row.impName, recordedID: null, actualID: imp.id },
          );
        }

        if (imp !== null) {
          await host.destroyHost(hostKey);
        }

        if ((await tryReadImp(host, row.impName)) !== null) {
          throw new Error(`imp ${row.impName} is still listed after its destroy`);
        }
      } catch (error) {
        throw buildRevocationPending(hostKey, [formatError(error)]);
      }

      await this.store.removeAuthBinding(hostKey);

      return true;
    });
  }

  /**
   * Settles, as a daemon starts, the bindings a stopped daemon left
   * mid-change. A provisioning binding with no fleet entry on its host
   * was a spawn that never listed, and its attempt is taken back; a
   * rebind in flight becomes a failed rebind, whose added grants are
   * removed. Each host is reached through its target's broker, or left as
   * it is, still blocked, when its target has none here. Failures are
   * reported and leave the binding blocked for the next start.
   */
  async reconcileBindings(
    findHost: (target: string) => CredentialBroker | null,
    listedHostKeys: ReadonlySet<SessionID>,
    log: (line: string) => void,
  ): Promise<void> {
    const rows = await this.store.collectAuthBindings();

    for (const row of rows) {
      const host = findHost(row.target);

      const plan = planBindingReconcile(row, {
        isOrphan: !listedHostKeys.has(row.hostKey),
        hasHost: host !== null,
      });

      try {
        if (plan === 'settle_rebind') {
          await this.reconcileRebind(host, row);
        }

        if (plan === 'remove_attempt' && host !== null) {
          await this.removeAttempt(host, row.hostKey, row.attemptID);
        }
      } catch (error) {
        log(
          `atc could not settle the runtime auth of host ${row.hostKey} (${formatError(error)}); it stays blocked`,
        );
      }
    }
  }

  // The imp, given the read of its name, then its id on the record, then
  // the check that impd holds no grant on it, then the grants at once, each
  // one recorded as granting before impd is asked and as granted after.
  // Every grant settles before a failed one rejects, so a take-back never
  // runs beside a grant still in flight.
  private async createImpAndGrants(
    host: CredentialBroker,
    hostKey: SessionID,
    impName: string,
    binding: AuthBinding,
    attemptID: string,
    read: PromiseSettledResult<BrokerHost | null>,
  ): Promise<void> {
    const existing = getSettledValue(read);

    if (existing !== null) {
      await this.store.removeAuthBinding(hostKey);

      throw new DaemonError(
        'auth_runtime_exists',
        `imp ${impName} already exists, and atc never grants a credential to an imp it did not make`,
        { imp: impName },
      );
    }

    let imp: BrokerHost;

    try {
      imp = await host.createHost(hostKey);
    } catch (error) {
      // A create impd refused made nothing, so the record goes with it. One
      // that never answered may have made an imp, which the take-back
      // settles by what impd shows under the name.
      if (error instanceof CredentialBrokerError && error.code !== 'unreachable') {
        await this.store.removeAuthBinding(hostKey);
      }

      throw error;
    }

    await this.store.updateAuthBinding(
      hostKey,
      { impID: imp.id, impCreatedByAttempt: true },
      this.now(),
    );

    const held = await host.readGrants(impName);

    if (held.length > 0) {
      throw new DaemonError(
        'auth_grants_mismatch',
        `the new imp ${impName} already holds ${held.join(', ')}`,
        { host: hostKey, extra: held },
      );
    }

    const granted = await Promise.allSettled(
      binding.secrets.map(async (secret) => {
        const grant = {
          hostKey,
          secret: secret.secret,
          revision: 1,
          attemptID,
          preexisting: false,
        };

        await this.store.upsertAuthGrant({ ...grant, phase: 'granting' }, this.now());
        await host.createGrant(impName, secret.secret);
        await this.store.upsertAuthGrant({ ...grant, phase: 'granted' }, this.now());
      }),
    );

    for (const result of granted) {
      getSettledValue(result);
    }
  }

  private async removeAttemptLocked(
    host: CredentialBroker,
    hostKey: SessionID,
    attemptID: string,
  ): Promise<void> {
    const row = await this.store.findAuthBinding(hostKey);

    if (row === null || row.attemptID !== attemptID || row.rebind !== null) {
      return;
    }

    try {
      if (row.impID === null || !row.impCreatedByAttempt) {
        // Nothing this attempt made carries an id, so only an empty name
        // lets the record go.
        if ((await tryReadImp(host, row.impName)) !== null) {
          throw new Error(
            `imp ${row.impName} exists, and nothing shows this attempt created it; reconcile it by hand`,
          );
        }
      } else {
        assertRecordedImpName(host, row);

        const imp = await verifyCleanupAuthority(host, { name: row.impName, id: row.impID });

        if (imp !== null) {
          await host.destroyHost(hostKey);
        }

        if ((await tryReadImp(host, row.impName)) !== null) {
          throw new Error(`imp ${row.impName} is still listed after its destroy`);
        }
      }
    } catch (error) {
      await this.store.updateAuthBinding(hostKey, { state: 'rollback_pending' }, this.now());

      throw new EffectRemainsError(
        `atc could not take back the runtime auth of host ${hostKey} (${formatError(error)})`,
        { cause: error },
      );
    }

    await this.store.removeAuthBinding(hostKey);
  }

  private async requireBinding(hostKey: SessionID): Promise<RuntimeAuthBinding> {
    const row = await this.store.findAuthBinding(hostKey);

    if (row === null) {
      throw new DaemonError(
        'unsupported_operation',
        `host ${hostKey} has no runtime auth binding`,
        { host: hostKey, problem: 'no_auth_binding' },
      );
    }

    return row;
  }

  // Revokes each bound or recorded grant and returns the secrets it could
  // not confirm gone. An imp impd shows gone took every grant with it.
  private async revokeGrants(
    host: CredentialBroker | null,
    row: RuntimeAuthBinding,
  ): Promise<string[]> {
    const grants = await this.store.collectAuthGrants(row.hostKey);

    const secrets = collectBindingSecrets(row, grants);

    if (host === null || row.impID === null) {
      await this.updateGrantPhases(row, grants, secrets, 'revocation_pending');

      return secrets;
    }

    const recorded = { name: row.impName, id: row.impID };
    let imp: BrokerHost | null;

    try {
      imp = await verifyCleanupAuthority(host, recorded);
    } catch {
      await this.updateGrantPhases(row, grants, secrets, 'revocation_pending');

      return secrets;
    }

    if (imp === null) {
      await this.updateGrantPhases(row, grants, secrets, 'revoked');

      return [];
    }

    const pending: string[] = [];

    for (const secret of secrets) {
      await this.updateGrantPhases(row, grants, [secret], 'revoking');

      const revoked = await tryRevokeGrant(host, row.impName, secret);

      const phase = revoked ? 'revoked' : 'revocation_pending';

      await this.updateGrantPhases(row, grants, [secret], phase);

      if (!revoked) {
        pending.push(secret);
      }
    }

    return pending;
  }

  private async updateGrantPhases(
    row: RuntimeAuthBinding,
    grants: readonly RuntimeAuthGrant[],
    secrets: readonly string[],
    phase: RuntimeAuthGrant['phase'],
  ): Promise<void> {
    for (const secret of secrets) {
      const grant = grants.find((g) => g.secret === secret);

      await this.store.upsertAuthGrant(
        {
          hostKey: row.hostKey,
          secret,
          revision: grant?.revision ?? row.revision,
          attemptID: grant?.attemptID ?? row.attemptID,
          preexisting: grant?.preexisting ?? false,
          phase,
        },
        this.now(),
      );
    }
  }

  // Grants each secret of the new binding the imp lacks, recording one it
  // already holds as preexisting, then revokes each held grant the new
  // binding drops.
  private async applyRebindGrants(
    host: CredentialBroker,
    row: RuntimeAuthBinding,
    binding: AuthBinding,
    revision: number,
    attemptID: string,
  ): Promise<void> {
    const held = await host.readGrants(row.impName);

    const bound = binding.secrets.map((secret) => secret.secret);

    for (const secret of bound) {
      const grant = { hostKey: row.hostKey, secret, revision, attemptID };

      if (held.includes(secret)) {
        await this.store.upsertAuthGrant(
          { ...grant, preexisting: true, phase: 'granted' },
          this.now(),
        );
      } else {
        await this.store.upsertAuthGrant(
          { ...grant, preexisting: false, phase: 'granting' },
          this.now(),
        );

        await host.createGrant(row.impName, secret);

        await this.store.upsertAuthGrant(
          { ...grant, preexisting: false, phase: 'granted' },
          this.now(),
        );
      }
    }

    for (const secret of held.filter((name) => !bound.includes(name))) {
      const grant = {
        hostKey: row.hostKey,
        secret,
        revision,
        attemptID,
        preexisting: true,
      };

      await this.store.upsertAuthGrant({ ...grant, phase: 'revoking' }, this.now());

      if (!(await tryRevokeGrant(host, row.impName, secret))) {
        await this.store.upsertAuthGrant({ ...grant, phase: 'revocation_pending' }, this.now());

        throw new DaemonError(
          'auth_revocation_pending',
          `imp ${row.impName} may still hold ${secret}, which the new binding drops`,
          { host: row.hostKey, pending: [secret] },
        );
      }

      await this.store.upsertAuthGrant({ ...grant, phase: 'revoked' }, this.now());
    }
  }

  // Revokes each grant a rebind attempt added, which only it can have
  // made, and records each it could not confirm gone as pending.
  private async removeRebindGrants(
    host: CredentialBroker | null,
    hostKey: SessionID,
    impName: string,
    attemptID: string,
  ): Promise<void> {
    const grants = await this.store.collectAuthGrants(hostKey);

    const added = grants.filter(
      (grant) =>
        grant.attemptID === attemptID &&
        !grant.preexisting &&
        (grant.phase === 'granting' ||
          grant.phase === 'granted' ||
          grant.phase === 'uncertain' ||
          grant.phase === 'revocation_pending'),
    );

    for (const grant of added) {
      const revoked = host === null ? false : await tryRevokeGrant(host, impName, grant.secret);

      await this.store.upsertAuthGrant(
        { ...grant, phase: revoked ? 'revoked' : 'revocation_pending' },
        this.now(),
      );
    }
  }

  // A rebind a stopped daemon left in flight failed: it is blocked first,
  // and the grants its attempt added are removed only from the imp it was
  // recorded against. A failed rebind whose removal never finished is
  // tried again on each start. Nothing changes unless the binding still
  // holds the same imp, revision, and rebind attempt under the host's lock.
  private async reconcileRebind(
    host: CredentialBroker | null,
    row: RuntimeAuthBinding,
  ): Promise<void> {
    const rebind = row.rebind;
    const impID = row.impID;

    if (rebind === null) {
      return;
    }

    await this.withHostLock(row.hostKey, async () => {
      const current = await this.store.findAuthBinding(row.hostKey);

      if (
        current === null ||
        current.impID !== impID ||
        current.revision !== row.revision ||
        current.state !== row.state ||
        current.rebind?.attemptID !== rebind.attemptID
      ) {
        return;
      }

      await this.store.updateAuthBinding(row.hostKey, { state: 'rebind_failed' }, this.now());

      if (host === null || impID === null) {
        return;
      }

      assertRecordedImpName(host, row);

      const imp = await verifyCleanupAuthority(host, { name: row.impName, id: impID });

      if (imp !== null) {
        await this.removeRebindGrants(host, row.hostKey, row.impName, rebind.attemptID);
      }
    });
  }
}

// Refuses a provider whose name for the host is not the imp the binding
// recorded, such as after the target's imp name prefix changed, so a
// destroy by host key never reaches another imp.
function assertRecordedImpName(host: CredentialBroker, row: RuntimeAuthBinding): void {
  const name = host.getHostName(row.hostKey);

  if (name !== row.impName) {
    throw new BrokerAuthorityError(
      'auth_runtime_mismatch',
      `host ${row.hostKey} was bound to imp ${row.impName}, but its target now names it ${name}`,
      { imp: row.impName, recordedID: row.impID, actualID: null },
    );
  }
}

// The full gate on a binding: impd's features and the token's authority
// over the imp and every bound secret, then each secret's kind and rules.
// The secrets are read with the authority's reads and checked after them.
async function verifyGate(
  host: CredentialBroker,
  impName: string,
  binding: AuthBinding,
): Promise<void> {
  const secrets = binding.secrets.map((secret) => secret.secret);

  const oauthSecrets = binding.secrets
    .filter((secret) => secret.kind === 'oauth')
    .map((secret) => secret.secret);

  const [authority, secretsRead] = await Promise.allSettled([
    verifyBrokerAuthority(host, { impNames: [impName], secrets, oauthSecrets }),
    host.readSecrets(),
  ]);

  getSettledValue(authority);

  const held = getSettledValue(secretsRead);
  const mismatches = collectSecretRuleMismatches(binding.secrets, held);

  if (mismatches.length > 0) {
    throw new DaemonError(
      'auth_secret_mismatch',
      `impd holds ${mismatches.map((mismatch) => `${mismatch.secret} (${mismatch.reason})`).join(', ')} unlike the binding`,
      { mismatches },
    );
  }
}

async function tryReadImp(host: CredentialBroker, name: string) {
  try {
    return await host.readHost(name);
  } catch (error) {
    throw toAuthRefusal(error);
  }
}

async function tryReadGrants(host: CredentialBroker, name: string): Promise<readonly string[]> {
  try {
    return await host.readGrants(name);
  } catch (error) {
    throw toAuthRefusal(error);
  }
}

// Whether a grant is gone: revoked now, already gone, its imp or secret
// gone, or, when impd forbids the revoke, absent from the imp's grants.
async function tryRevokeGrant(
  host: CredentialBroker,
  impName: string,
  secret: string,
): Promise<boolean> {
  try {
    await host.removeGrant(impName, secret);

    return true;
  } catch (error) {
    if (error instanceof CredentialBrokerError && error.code === 'not_found') {
      return true;
    }

    if (!(error instanceof CredentialBrokerError && error.code === 'forbidden')) {
      return false;
    }
  }

  try {
    const held = await host.readGrants(impName);

    return !held.includes(secret);
  } catch (error) {
    return error instanceof CredentialBrokerError && error.code === 'not_found';
  }
}

// The secrets a binding grants and any its grant rows still record.
function collectBindingSecrets(
  row: RuntimeAuthBinding,
  grants: readonly RuntimeAuthGrant[],
): string[] {
  const bound = parseBoundSecrets(row.bindingJSON);

  return [...new Set([...bound, ...grants.map((grant) => grant.secret)])].toSorted();
}

// A stored binding's secrets, each read on its own so one that does not read
// leaves the rest.
const BINDING_SECRETS_SCHEMA = z.object({ secrets: z.array(z.unknown()) });
const BOUND_SECRET_SCHEMA = z.object({ secret: z.string() });

function parseBoundSecrets(json: string): string[] {
  const parsed = BINDING_SECRETS_SCHEMA.safeParse(JSON.parse(json));

  if (!parsed.success) {
    return [];
  }

  return parsed.data.secrets.flatMap((entry) => {
    const bound = BOUND_SECRET_SCHEMA.safeParse(entry);

    return bound.success ? [bound.data.secret] : [];
  });
}

// A stored binding's profile names, or none when they do not read.
const BINDING_PROFILES_SCHEMA = z.object({ profiles: z.array(z.string()) });

function parseBoundProfiles(json: string): string[] {
  const parsed = BINDING_PROFILES_SCHEMA.safeParse(JSON.parse(json));

  return parsed.success ? parsed.data.profiles : [];
}

function formatNames(names: readonly string[]): string {
  return names.length === 0 ? 'none' : names.join(', ');
}

function buildRevocationPending(hostKey: SessionID, pending: readonly string[]): DaemonError {
  return new DaemonError(
    'auth_revocation_pending',
    `revocation pending for host ${hostKey}, owner intervention needed: atc could not confirm ${pending.join(', ')} gone, and launches stay blocked`,
    { host: hostKey, pending },
  );
}

// An impd refusal or an authority refusal as the daemon error it answers.
function toAuthRefusal(error: unknown): unknown {
  if (error instanceof DaemonError || error instanceof EffectRemainsError) {
    return error;
  }

  if (error instanceof BrokerAuthorityError) {
    return new DaemonError(error.code, error.message, error.data);
  }

  if (error instanceof CredentialBrokerError) {
    return new DaemonError(
      'host_unavailable',
      `impd refused a runtime auth call: ${error.message}`,
      {
        provider: 'imp',
        problem: error.brokerCode.toLowerCase(),
      },
    );
  }

  return error;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
