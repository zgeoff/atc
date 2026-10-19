import { randomUUID } from 'node:crypto';
import { getSettledValue, makeKeyedLock, systemClock } from '@atc/core';
import type { SessionID } from '@atc/core';
import type { CredentialBroker, LaunchTicket } from '@atc/plugin-api';
import { DaemonError } from '@atc/protocol/wire';
import type { RuntimeAuthBinding } from '@atc/store';
import { z } from 'zod';
import { assertRecordedHostName } from './assert-recorded-host-name';
import { BrokerAuthorityError } from './broker-authority-error';
import type { AuthBinding } from './build-auth-binding';
import { buildRevocationPending } from './build-revocation-pending';
import { createHostAndGrants } from './create-host-and-grants';
import { formatError } from './format-error';
import { LaunchAdmissions } from './launch-admissions';
import { parseBoundSecrets } from './parse-bound-secrets';
import { planBindingReconcile } from './plan-binding-reconcile';
import { planBindingVerify } from './plan-binding-verify';
import { planLaunchAdmission } from './plan-launch-admission';
import { planReadyUpdate } from './plan-ready-update';
import { removeAttemptLocked } from './remove-attempt-locked';
import { removeRebindGrants } from './remove-rebind-grants';
import { revokeGrants } from './revoke-grants';
import type { RuntimeAuthLedger, RuntimeAuthStore } from './runtime-auth-ledger';
import { toAuthRefusal } from './to-auth-refusal';
import { tryReadGrants } from './try-read-grants';
import { tryReadHost } from './try-read-host';
import { updateBindingLocked } from './update-binding-locked';
import { verifyCleanupAuthority } from './verify-cleanup-authority';
import { verifyGate } from './verify-gate';

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

export class RuntimeAuthBinder {
  private readonly store: RuntimeAuthStore;

  private readonly now: () => number;

  private readonly ledger: RuntimeAuthLedger;

  // Runs each call on a host after the one before it on that host.
  private readonly withHostLock = makeKeyedLock();

  private readonly admissions = new LaunchAdmissions();

  constructor(store: RuntimeAuthStore, now: () => number = systemClock.now) {
    this.store = store;
    this.now = now;
    this.ledger = { store, now };
  }

  readBinding(hostKey: SessionID): Promise<RuntimeAuthBinding | null> {
    return this.store.readAuthBinding(hostKey);
  }

  // a take-back that cannot be confirmed rejects with an effect that remains
  createBinding(host: CredentialBroker, request: BindingRequest): Promise<string> {
    return this.withHostLock(request.hostKey, async () => {
      const hostName = host.getHostName(request.hostKey);
      const binding = request.binding;

      // The read of the name goes out with the gate's reads, and the gate
      // still refuses first.
      const [gate, existing] = await Promise.allSettled([
        verifyGate(host, hostName, binding),
        host.readHost(hostName),
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
          hostName,
          bindingHash: binding.hash,
          bindingJSON: JSON.stringify(binding),
          attemptID,
        },
        this.now(),
      );

      try {
        await createHostAndGrants(this.ledger, host, {
          hostKey: request.hostKey,
          hostName,
          binding,
          attemptID,
          read: existing,
        });
      } catch (error) {
        await removeAttemptLocked(this.ledger, host, request.hostKey, attemptID);

        throw toAuthRefusal(error);
      }

      return attemptID;
    });
  }

  async updateReady(hostKey: SessionID, attemptID: string): Promise<void> {
    await this.withHostLock(hostKey, async () => {
      const row = await this.store.readAuthBinding(hostKey);

      if (planReadyUpdate(row, attemptID) === 'ready') {
        await this.store.updateAuthBinding(hostKey, { state: 'ready' }, this.now());
      }
    });
  }

  // every check only reads, so a refusal changes nothing
  verifyBinding(
    host: CredentialBroker,
    hostKey: SessionID,
    binding: AuthBinding,
    rebind: ChangedAuthRebind | null = null,
  ): Promise<RuntimeAuthBinding> {
    return this.withHostLock(hostKey, async () => {
      const row = await this.store.readAuthBinding(hostKey);

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

      // The host and its grants are read with the gate's reads, and each
      // check still refuses in the gate, host, grants order.
      const [gate, hostRead, grantsRead] = await Promise.allSettled([
        verifyGate(host, row.hostName, binding),
        tryReadHost(host, row.hostName),
        tryReadGrants(host, row.hostName),
      ]);

      try {
        getSettledValue(gate);
      } catch (error) {
        throw toAuthRefusal(error);
      }

      const found = getSettledValue(hostRead);

      if (found === null || found.id !== row.hostID || row.hostName !== host.getHostName(hostKey)) {
        throw new DaemonError(
          'auth_runtime_mismatch',
          `host ${row.hostName} is no longer the one host ${hostKey} was bound to`,
          {
            host: hostKey,
            hostName: row.hostName,
            recordedID: row.hostID,
            actualID: found?.id ?? null,
          },
        );
      }

      const held = getSettledValue(grantsRead);
      const bound = binding.secrets.map((secret) => secret.secret);
      const missing = bound.filter((secret) => !held.includes(secret));
      const extra = held.filter((secret) => !bound.includes(secret));

      if (missing.length > 0) {
        throw new DaemonError(
          'auth_grant_missing',
          `host ${row.hostName} no longer holds ${missing.join(', ')}; atc never grants it again on its own, so rebind the host`,
          { host: hostKey, missing },
        );
      }

      if (extra.length > 0) {
        throw new DaemonError(
          'auth_grants_mismatch',
          `host ${row.hostName} holds ${extra.join(', ')}, which its binding does not grant`,
          { host: hostKey, extra },
        );
      }

      return row;
    });
  }

  private async updateChangedBinding(
    host: CredentialBroker,
    row: RuntimeAuthBinding,
    binding: AuthBinding,
    rebind: ChangedAuthRebind,
  ): Promise<RuntimeAuthBinding> {
    const found = await tryReadHost(host, row.hostName);

    if (
      found === null ||
      found.id !== row.hostID ||
      row.hostName !== host.getHostName(row.hostKey)
    ) {
      throw new DaemonError(
        'auth_runtime_mismatch',
        `host ${row.hostName} is no longer the one host ${row.hostKey} was bound to`,
        {
          host: row.hostKey,
          hostName: row.hostName,
          recordedID: row.hostID,
          actualID: found?.id ?? null,
        },
      );
    }

    // a failed rebind's added grants go first, so one whose removal failed does not read as a
    // grant the binding never made
    if (row.state === 'rebind_failed' && row.rebind !== null) {
      await removeRebindGrants(this.ledger, host, {
        hostKey: row.hostKey,
        hostName: row.hostName,
        attemptID: row.rebind.attemptID,
      });
    }

    const held = await tryReadGrants(host, row.hostName);

    const recorded = parseBoundSecrets(row.bindingJSON);

    const bound = new Set(binding.secrets.map((secret) => secret.secret));

    const missing = recorded.filter((secret) => bound.has(secret) && !held.includes(secret));
    const extra = held.filter((secret) => !recorded.includes(secret));

    if (missing.length > 0) {
      throw new DaemonError(
        'auth_grant_missing',
        `host ${row.hostName} no longer holds ${missing.join(', ')}; atc never grants it again on its own, so rebind the host`,
        { host: row.hostKey, missing },
      );
    }

    if (extra.length > 0) {
      throw new DaemonError(
        'auth_grants_mismatch',
        `host ${row.hostName} holds ${extra.join(', ')}, which its binding does not grant`,
        { host: row.hostKey, extra },
      );
    }

    const revision = await updateBindingLocked(this.ledger, host, row, binding);

    const before = parseBoundProfiles(row.bindingJSON);
    const added = binding.profiles.filter((profile) => !before.includes(profile));
    const removed = before.filter((profile) => !binding.profiles.includes(profile));

    rebind.log(
      `atc: rebound the runtime auth of host ${row.hostKey} from revision ${String(row.revision)} to revision ${String(revision)} (added profiles: ${formatNames(added)}; removed profiles: ${formatNames(removed)})`,
    );

    return this.requireBinding(row.hostKey);
  }

  withLaunchAdmission(
    hostKey: SessionID,
    admission: LaunchAdmission,
    kind: 'start' | 'attach',
    send: (ticket: LaunchTicket) => void,
  ): Promise<void> {
    return this.withHostLock(hostKey, async () => {
      const row = await this.store.readAuthBinding(hostKey);

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

      // the client checks the ticket just before the request goes out, so a revoke, a rebind or
      // a forget that came first stops it unsent; the lock never spans the network
      send(this.admissions.createTicket(hostKey));
    });
  }

  // How many admitted requests on a host have not gone out or ended yet.
  countPendingAdmissions(hostKey: SessionID): number {
    return this.admissions.countPendingAdmissions(hostKey);
  }

  // rejects with an effect that remains when it cannot confirm the host gone, leaving the
  // binding pending its take-back
  async removeAttempt(
    host: CredentialBroker,
    hostKey: SessionID,
    attemptID: string,
  ): Promise<void> {
    await this.withHostLock(hostKey, () =>
      removeAttemptLocked(this.ledger, host, hostKey, attemptID),
    );
  }

  async revokeBinding(host: CredentialBroker | null, hostKey: SessionID): Promise<void> {
    await this.withHostLock(hostKey, async () => {
      this.admissions.revokeAdmissions(hostKey, 'revocation_pending');

      const row = await this.requireBinding(hostKey);

      await this.store.updateAuthBinding(hostKey, { state: 'revocation_pending' }, this.now());

      const pending = await revokeGrants(this.ledger, host, row);

      if (pending.length > 0) {
        throw buildRevocationPending(hostKey, pending);
      }

      const at = this.now();

      await this.store.updateAuthBinding(hostKey, { state: 'revoked', revokedAt: at }, at);
    });
  }

  updateBinding(host: CredentialBroker, hostKey: SessionID, binding: AuthBinding): Promise<number> {
    return this.withHostLock(hostKey, async () => {
      this.admissions.revokeAdmissions(hostKey, 'provisioning');

      const row = await this.requireBinding(hostKey);

      return updateBindingLocked(this.ledger, host, row, binding);
    });
  }

  // resolves false for a host with no binding, leaving the destroy to the caller; never
  // deletes a secret
  forgetBinding(host: CredentialBroker | null, hostKey: SessionID): Promise<boolean> {
    return this.withHostLock(hostKey, async () => {
      this.admissions.revokeAdmissions(hostKey, 'revocation_pending');

      const row = await this.store.readAuthBinding(hostKey);

      if (row === null) {
        return false;
      }

      await this.store.updateAuthBinding(hostKey, { state: 'revocation_pending' }, this.now());

      if (host === null) {
        throw buildRevocationPending(hostKey, ['(host unreachable)']);
      }

      try {
        assertRecordedHostName(host, row);

        const found =
          row.hostID === null
            ? await tryReadHost(host, row.hostName)
            : await verifyCleanupAuthority(host, { name: row.hostName, id: row.hostID });

        if (found !== null && row.hostID === null) {
          throw new BrokerAuthorityError(
            'auth_runtime_mismatch',
            `host ${row.hostName} exists, but host ${hostKey} never recorded its id`,
            { hostName: row.hostName, recordedID: null, actualID: found.id },
          );
        }

        if (found !== null) {
          await host.destroyHost(hostKey);
        }

        if ((await tryReadHost(host, row.hostName)) !== null) {
          throw new Error(`host ${row.hostName} is still listed after its destroy`);
        }
      } catch (error) {
        throw buildRevocationPending(hostKey, [formatError(error)]);
      }

      await this.store.removeAuthBinding(hostKey);

      return true;
    });
  }

  async reconcileBindings(
    findHost: (target: string) => CredentialBroker | null,
    listedHostKeys: ReadonlySet<SessionID>,
    log: (line: string) => void,
  ): Promise<void> {
    const rows = await this.store.readAuthBindings();

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

  private async requireBinding(hostKey: SessionID): Promise<RuntimeAuthBinding> {
    const row = await this.store.readAuthBinding(hostKey);

    if (row === null) {
      throw new DaemonError(
        'unsupported_operation',
        `host ${hostKey} has no runtime auth binding`,
        { host: hostKey, problem: 'no_auth_binding' },
      );
    }

    return row;
  }

  // a failed rebind whose grant removal never finished stays blocked and is tried again on
  // each start
  private async reconcileRebind(
    host: CredentialBroker | null,
    row: RuntimeAuthBinding,
  ): Promise<void> {
    const rebind = row.rebind;
    const hostID = row.hostID;

    if (rebind === null) {
      return;
    }

    await this.withHostLock(row.hostKey, async () => {
      const current = await this.store.readAuthBinding(row.hostKey);

      if (
        current === null ||
        current.hostID !== hostID ||
        current.revision !== row.revision ||
        current.state !== row.state ||
        current.rebind?.attemptID !== rebind.attemptID
      ) {
        return;
      }

      await this.store.updateAuthBinding(row.hostKey, { state: 'rebind_failed' }, this.now());

      if (host === null || hostID === null) {
        return;
      }

      assertRecordedHostName(host, row);

      const found = await verifyCleanupAuthority(host, { name: row.hostName, id: hostID });

      if (found !== null) {
        await removeRebindGrants(this.ledger, host, {
          hostKey: row.hostKey,
          hostName: row.hostName,
          attemptID: rebind.attemptID,
        });
      }
    });
  }
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
