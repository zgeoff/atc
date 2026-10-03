import { randomUUID } from 'node:crypto';
import { DaemonError } from '../protocol/daemon-error';
import type { SessionID } from '../shared/session-id';
import type { RuntimeAuthBinding, RuntimeAuthGrant } from '../store/runtime-auth-binding';
import type { StateStore } from '../store/state-store';
import type { BrokerAuthHost } from './broker-auth-host';
import { BrokerAuthorityError } from './broker-authority-error';
import type { AuthBinding } from './build-auth-binding';
import { collectSecretRuleMismatches } from './collect-secret-rule-mismatches';
import { EffectRemainsError } from './effect-remains-error';
import type { ImpView } from './imp-port';
import { ImpPortError } from './imp-port-error';
import { verifyBrokerAuthority } from './verify-broker-authority';
import { verifyCleanupAuthority } from './verify-cleanup-authority';

/**
 * The store calls the binder makes: a host's binding and its grant rows.
 */
export type RuntimeAuthStore = Pick<
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

/**
 * Binds a host's runtime auth through impd's credential broker and keeps
 * the binding's record in the store, one host at a time: every call on a
 * host waits for the one before it on that host.
 *
 * A spawn creates the binding: the full gate, then the record, then a new
 * imp, then each grant, each step recorded before the next. A resume, a
 * restore, and a sub-session joining the host verify it: the full gate,
 * the imp's identity, and the exact grant set, and nothing is granted
 * again. A rebind moves the binding to a new revision. A revoke and a
 * forget first record the block that stops every launch, then check only
 * that the token may manage the recorded imp and that the imp is still
 * the one recorded, never a secret's rules or a complete grant set.
 * Nothing here falls back to a broader token or to a local launch.
 */
export class RuntimeAuthBinder {
  private readonly store: RuntimeAuthStore;

  private readonly now: () => number;

  // The tail of each host's chain of calls, which never rejects.
  private readonly locks = new Map<SessionID, Promise<void>>();

  constructor(store: RuntimeAuthStore, now: () => number = Date.now) {
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
  createBinding(host: BrokerAuthHost, request: BindingRequest): Promise<string> {
    return this.withHostLock(request.hostKey, async () => {
      const impName = host.getImpName(request.hostKey);
      const binding = request.binding;

      try {
        await verifyGate(host, impName, binding);
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
        await this.createImpAndGrants(host, request.hostKey, impName, binding, attemptID);
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

      if (row?.state === 'provisioning' && row.attemptID === attemptID && row.rebind === null) {
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
   */
  verifyBinding(
    host: BrokerAuthHost,
    hostKey: SessionID,
    binding: AuthBinding,
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

      if (row.state !== 'ready') {
        throw new DaemonError(
          'auth_blocked',
          `the runtime auth of host ${hostKey} is ${row.state}; rebind it to launch again`,
          { host: hostKey, state: row.state },
        );
      }

      if (row.bindingHash !== binding.hash) {
        throw new DaemonError(
          'auth_rebind_required',
          `the auth profiles host ${hostKey} uses changed since it was bound; rebind it to adopt them`,
          { host: hostKey, revision: row.revision },
        );
      }

      try {
        await verifyGate(host, row.impName, binding);
      } catch (error) {
        throw toAuthRefusal(error);
      }

      const imp = await tryReadImp(host, row.impName);

      if (imp === null || imp.id !== row.impID || row.impName !== host.getImpName(hostKey)) {
        throw new DaemonError(
          'auth_runtime_mismatch',
          `imp ${row.impName} is no longer the imp host ${hostKey} was bound to`,
          { host: hostKey, imp: row.impName, recordedID: row.impID, actualID: imp?.id ?? null },
        );
      }

      const held = await tryReadGrants(host, row.impName);

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

  /**
   * Takes back what one spawn attempt made: the imp, with every grant on
   * it, but only an imp this attempt created whose id impd still shows
   * under the name, and then the record. An imp atc cannot tell apart from
   * one it did not make is left alone, and so is any attempt but the one
   * given. Rejects with an effect that remains when it cannot confirm the
   * imp gone, leaving the binding pending its take-back.
   */
  async removeAttempt(host: BrokerAuthHost, hostKey: SessionID, attemptID: string): Promise<void> {
    await this.withHostLock(hostKey, () => this.removeAttemptLocked(host, hostKey, attemptID));
  }

  /**
   * Withdraws every grant of a host's binding. The block that stops every
   * launch is written first, even when impd cannot be reached; a grant impd
   * no longer holds counts as revoked; a running harness keeps running and
   * impd fails its later requests. Rejects with `auth_revocation_pending`
   * when any grant cannot be confirmed gone.
   */
  async revokeBinding(host: BrokerAuthHost | null, hostKey: SessionID): Promise<void> {
    await this.withHostLock(hostKey, async () => {
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
  updateBinding(host: BrokerAuthHost, hostKey: SessionID, binding: AuthBinding): Promise<number> {
    return this.withHostLock(hostKey, async () => {
      const row = await this.requireBinding(hostKey);

      if (row.state !== 'ready' && row.state !== 'revoked' && row.state !== 'rebind_failed') {
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

        const imp = await verifyCleanupAuthority(
          host.port,
          { name: row.impName, id: row.impID },
          host.impPrefix,
        );

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
    });
  }

  /**
   * Destroys a bound host's imp for a forget and drops its record, and
   * resolves false when the host has no binding, which leaves the destroy
   * to the caller. The block is written first; only an imp impd still
   * shows under the recorded id is destroyed, and the record goes once
   * impd shows no imp under the name. Never deletes a secret.
   */
  forgetBinding(host: BrokerAuthHost | null, hostKey: SessionID): Promise<boolean> {
    return this.withHostLock(hostKey, async () => {
      const row = await this.store.findAuthBinding(hostKey);

      if (row === null) {
        return false;
      }

      await this.store.updateAuthBinding(hostKey, { state: 'revocation_pending' }, this.now());

      if (host === null) {
        throw buildRevocationPending(hostKey, ['(imp unreachable)']);
      }

      try {
        const imp =
          row.impID === null
            ? await tryReadImp(host, row.impName)
            : await verifyCleanupAuthority(
                host.port,
                { name: row.impName, id: row.impID },
                host.impPrefix,
              );

        if (imp !== null && row.impID === null) {
          throw new BrokerAuthorityError(
            'auth_runtime_mismatch',
            `imp ${row.impName} exists, but host ${hostKey} never recorded its id`,
            { imp: row.impName, recordedID: null, actualID: imp.id },
          );
        }

        if (imp !== null) {
          await host.destroyImp(hostKey);
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
    findHost: (target: string) => BrokerAuthHost | null,
    listedHostKeys: ReadonlySet<SessionID>,
    log: (line: string) => void,
  ): Promise<void> {
    const rows = await this.store.collectAuthBindings();

    for (const row of rows) {
      const host = findHost(row.target);
      const isOrphan = !listedHostKeys.has(row.hostKey);

      try {
        if (row.rebind !== null && row.state === 'provisioning') {
          await this.reconcileRebind(host, row);
        } else if (
          isOrphan &&
          (row.state === 'provisioning' || row.state === 'rollback_pending') &&
          host !== null
        ) {
          await this.removeAttempt(host, row.hostKey, row.attemptID);
        }
      } catch (error) {
        log(
          `atc could not settle the runtime auth of host ${row.hostKey} (${formatError(error)}); it stays blocked`,
        );
      }
    }
  }

  // Runs each call on a host after the one before it on that host.
  private async withHostLock<T>(hostKey: SessionID, run: () => Promise<T>): Promise<T> {
    const before = this.locks.get(hostKey);
    const turn = Promise.withResolvers<void>();

    this.locks.set(hostKey, turn.promise);

    try {
      if (before !== undefined) {
        await before;
      }

      return await run();
    } finally {
      turn.resolve();

      if (this.locks.get(hostKey) === turn.promise) {
        this.locks.delete(hostKey);
      }
    }
  }

  // The imp, then its id on the record, then the check that impd holds no
  // grant on it, then each grant, each one recorded as granting before impd
  // is asked and as granted after.
  private async createImpAndGrants(
    host: BrokerAuthHost,
    hostKey: SessionID,
    impName: string,
    binding: AuthBinding,
    attemptID: string,
  ): Promise<void> {
    const existing = await host.port.readImp(impName);

    if (existing !== null) {
      await this.store.removeAuthBinding(hostKey);

      throw new DaemonError(
        'auth_runtime_exists',
        `imp ${impName} already exists, and atc never grants a credential to an imp it did not make`,
        { imp: impName },
      );
    }

    let imp: ImpView;

    try {
      imp = await host.createImp(hostKey);
    } catch (error) {
      // A create impd refused made nothing, so the record goes with it. One
      // that never answered may have made an imp, which the take-back
      // settles by what impd shows under the name.
      if (error instanceof ImpPortError && error.code !== 'UNREACHABLE') {
        await this.store.removeAuthBinding(hostKey);
      }

      throw error;
    }

    await this.store.updateAuthBinding(
      hostKey,
      { impID: imp.id, impCreatedByAttempt: true },
      this.now(),
    );

    const held = await host.port.readGrants(impName);

    if (held.length > 0) {
      throw new DaemonError(
        'auth_grants_mismatch',
        `the new imp ${impName} already holds ${held.join(', ')}`,
        { host: hostKey, extra: held },
      );
    }

    for (const secret of binding.secrets) {
      const grant = {
        hostKey,
        secret: secret.secret,
        revision: 1,
        attemptID,
        preexisting: false,
      };

      await this.store.upsertAuthGrant({ ...grant, phase: 'granting' }, this.now());
      await host.port.createGrant(impName, secret.secret);
      await this.store.upsertAuthGrant({ ...grant, phase: 'granted' }, this.now());
    }
  }

  private async removeAttemptLocked(
    host: BrokerAuthHost,
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
        const imp = await verifyCleanupAuthority(
          host.port,
          { name: row.impName, id: row.impID },
          host.impPrefix,
        );

        if (imp !== null) {
          await host.destroyImp(hostKey);
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
    host: BrokerAuthHost | null,
    row: RuntimeAuthBinding,
  ): Promise<string[]> {
    const grants = await this.store.collectAuthGrants(row.hostKey);

    const secrets = collectBindingSecrets(row, grants);

    if (host === null || row.impID === null) {
      await this.updateGrantPhases(row, grants, secrets, 'revocation_pending');

      return secrets;
    }

    const recorded = { name: row.impName, id: row.impID };
    let imp: ImpView | null;

    try {
      imp = await verifyCleanupAuthority(host.port, recorded, host.impPrefix);
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
    host: BrokerAuthHost,
    row: RuntimeAuthBinding,
    binding: AuthBinding,
    revision: number,
    attemptID: string,
  ): Promise<void> {
    const held = await host.port.readGrants(row.impName);

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

        await host.port.createGrant(row.impName, secret);

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
    host: BrokerAuthHost | null,
    hostKey: SessionID,
    impName: string,
    attemptID: string,
  ): Promise<void> {
    const grants = await this.store.collectAuthGrants(hostKey);

    const added = grants.filter(
      (grant) =>
        grant.attemptID === attemptID &&
        !grant.preexisting &&
        (grant.phase === 'granting' || grant.phase === 'granted' || grant.phase === 'uncertain'),
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
  // and its added grants are removed only from the imp it was recorded
  // against.
  private async reconcileRebind(
    host: BrokerAuthHost | null,
    row: RuntimeAuthBinding,
  ): Promise<void> {
    await this.store.updateAuthBinding(row.hostKey, { state: 'rebind_failed' }, this.now());

    const rebind = row.rebind;
    const impID = row.impID;

    if (host === null || impID === null || rebind === null) {
      return;
    }

    await this.withHostLock(row.hostKey, async () => {
      const current = await this.store.findAuthBinding(row.hostKey);

      if (
        current === null ||
        current.impID !== impID ||
        current.revision !== row.revision ||
        current.rebind?.attemptID !== rebind.attemptID
      ) {
        return;
      }

      const imp = await verifyCleanupAuthority(
        host.port,
        { name: row.impName, id: impID },
        host.impPrefix,
      );

      if (imp !== null) {
        await this.removeRebindGrants(host, row.hostKey, row.impName, rebind.attemptID);
      }
    });
  }
}

// The full gate on a binding: impd's features and the token's authority
// over the imp and every bound secret, then each secret's kind and rules.
async function verifyGate(
  host: BrokerAuthHost,
  impName: string,
  binding: AuthBinding,
): Promise<void> {
  const secrets = binding.secrets.map((secret) => secret.secret);

  await verifyBrokerAuthority(host.port, { impNames: [impName], secrets }, host.impPrefix);

  const held = await host.port.readSecrets();

  const mismatches = collectSecretRuleMismatches(binding.secrets, held);

  if (mismatches.length > 0) {
    throw new DaemonError(
      'auth_secret_mismatch',
      `impd holds ${mismatches.map((mismatch) => `${mismatch.secret} (${mismatch.reason})`).join(', ')} unlike the binding`,
      { mismatches },
    );
  }
}

async function tryReadImp(host: BrokerAuthHost, name: string) {
  try {
    return await host.port.readImp(name);
  } catch (error) {
    throw toAuthRefusal(error);
  }
}

async function tryReadGrants(host: BrokerAuthHost, name: string): Promise<readonly string[]> {
  try {
    return await host.port.readGrants(name);
  } catch (error) {
    throw toAuthRefusal(error);
  }
}

// Whether a grant is gone: revoked now, already gone, its imp or secret
// gone, or, when impd forbids the revoke, absent from the imp's grants.
async function tryRevokeGrant(
  host: BrokerAuthHost,
  impName: string,
  secret: string,
): Promise<boolean> {
  try {
    await host.port.removeGrant(impName, secret);

    return true;
  } catch (error) {
    if (error instanceof ImpPortError && error.code === 'NOT_FOUND') {
      return true;
    }

    if (!(error instanceof ImpPortError && error.code === 'FORBIDDEN')) {
      return false;
    }
  }

  try {
    const held = await host.port.readGrants(impName);

    return !held.includes(secret);
  } catch (error) {
    return error instanceof ImpPortError && error.code === 'NOT_FOUND';
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

function parseBoundSecrets(json: string): string[] {
  const parsed: unknown = JSON.parse(json);

  if (typeof parsed !== 'object' || parsed === null || !('secrets' in parsed)) {
    return [];
  }

  const secrets = parsed.secrets;

  if (!Array.isArray(secrets)) {
    return [];
  }

  return secrets.flatMap((secret: unknown) =>
    typeof secret === 'object' &&
    secret !== null &&
    'secret' in secret &&
    typeof secret.secret === 'string'
      ? [secret.secret]
      : [],
  );
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

  if (error instanceof ImpPortError) {
    return new DaemonError(
      'host_unavailable',
      `impd refused a runtime auth call: ${error.message}`,
      {
        provider: 'imp',
        problem: error.code.toLowerCase(),
      },
    );
  }

  return error;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
