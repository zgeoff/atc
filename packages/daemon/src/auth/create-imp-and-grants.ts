import { getSettledValue } from '@atc/core';
import type { SessionID } from '@atc/core';
import type { BrokerHost, CredentialBroker } from '@atc/plugin-api';
import { CredentialBrokerError } from '@atc/plugin-api';
import { DaemonError } from '@atc/protocol/wire';
import type { AuthBinding } from './build-auth-binding';
import type { RuntimeAuthLedger } from './runtime-auth-ledger';

// A fresh spawn's attempt: the host it provisions, the imp name and binding
// it grants under, and the read of that name that went out with the gate.
interface ImpAttempt {
  readonly hostKey: SessionID;
  readonly impName: string;
  readonly binding: AuthBinding;
  readonly attemptID: string;
  readonly read: Readonly<PromiseSettledResult<BrokerHost | null>>;
}

export async function createImpAndGrants(
  ledger: RuntimeAuthLedger,
  host: CredentialBroker,
  attempt: ImpAttempt,
): Promise<void> {
  const hostKey = attempt.hostKey;
  const impName = attempt.impName;
  const binding = attempt.binding;
  const attemptID = attempt.attemptID;
  const read = attempt.read;
  const existing = getSettledValue(read);

  if (existing !== null) {
    await ledger.store.removeAuthBinding(hostKey);

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
      await ledger.store.removeAuthBinding(hostKey);
    }

    throw error;
  }

  await ledger.store.updateAuthBinding(
    hostKey,
    { impID: imp.id, impCreatedByAttempt: true },
    ledger.now(),
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

      await ledger.store.upsertAuthGrant({ ...grant, phase: 'granting' }, ledger.now());
      await host.createGrant(impName, secret.secret);
      await ledger.store.upsertAuthGrant({ ...grant, phase: 'granted' }, ledger.now());
    }),
  );

  // every grant settles before a failed one rejects, so a take-back never runs beside a grant
  // still in flight
  for (const result of granted) {
    getSettledValue(result);
  }
}
