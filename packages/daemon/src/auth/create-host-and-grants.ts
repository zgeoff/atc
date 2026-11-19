import { getSettledValue } from '@atc/core';
import type { BrokerHost, CredentialBroker } from '@atc/plugin-api';
import { CredentialBrokerError } from '@atc/plugin-api';
import { DaemonError } from '@atc/protocol/wire';
import type { SessionID } from '@atcx/contract';
import type { AuthBinding } from './build-auth-binding';
import type { RuntimeAuthLedger } from './runtime-auth-ledger';

interface HostAttempt {
  readonly hostKey: SessionID;
  readonly hostName: string;
  readonly binding: AuthBinding;
  readonly attemptID: string;
  readonly read: Readonly<PromiseSettledResult<BrokerHost | null>>;
}

export async function createHostAndGrants(
  ledger: RuntimeAuthLedger,
  host: CredentialBroker,
  attempt: HostAttempt,
): Promise<void> {
  const hostKey = attempt.hostKey;
  const hostName = attempt.hostName;
  const binding = attempt.binding;
  const attemptID = attempt.attemptID;
  const read = attempt.read;
  const existing = getSettledValue(read);

  if (existing !== null) {
    await ledger.store.removeAuthBinding(hostKey);

    throw new DaemonError(
      'auth_runtime_exists',
      `host ${hostName} already exists, and atc never grants a credential to a host it did not make`,
      { hostName },
    );
  }

  let created: BrokerHost;

  try {
    created = await host.createHost(hostKey);
  } catch (error) {
    // A refused create made no host, so the record goes with it. A create that got no answer may
    // have made a host, so the record stays and the take-back settles it from what the broker lists.
    if (error instanceof CredentialBrokerError && error.code !== 'unreachable') {
      await ledger.store.removeAuthBinding(hostKey);
    }

    throw error;
  }

  await ledger.store.updateAuthBinding(
    hostKey,
    { hostID: created.id, hostCreatedByAttempt: true },
    ledger.now(),
  );

  const held = await host.readGrants(hostName);

  if (held.length > 0) {
    throw new DaemonError(
      'auth_grants_mismatch',
      `the new host ${hostName} already holds ${held.join(', ')}`,
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

      await ledger.store.upsertAuthGrant({ ...grant, phase: 'granting' }, ledger.now());
      await host.createGrant(hostName, secret.secret);
      await ledger.store.upsertAuthGrant({ ...grant, phase: 'granted' }, ledger.now());
    }),
  );

  // The first failure must not reject while other grants are still running, or the take-back would
  // race them. Wait for every grant to finish, then throw.
  for (const result of granted) {
    getSettledValue(result);
  }
}
