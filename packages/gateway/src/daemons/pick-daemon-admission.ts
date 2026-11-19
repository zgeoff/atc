import type { DaemonCheck } from '@atcx/contract';
import { match } from 'ts-pattern';

export type DaemonAdmission =
  | { readonly kind: 'admit' }
  | { readonly kind: 'warn'; readonly message: string }
  | { readonly kind: 'refuse'; readonly message: string };

export function pickDaemonAdmission(
  daemonName: string,
  build: string,
  check: DaemonCheck,
): DaemonAdmission {
  return match(check)
    .returnType<DaemonAdmission>()
    .with({ verdict: 'match' }, (matched) =>
      matched.missing.length === 0
        ? { kind: 'admit' }
        : {
            kind: 'warn',
            message: `daemon '${daemonName}' runs ${build}, which lacks ${matched.missing.join(', ')}; a call that needs one fails`,
          },
    )
    .with({ verdict: 'older' }, (skew) => ({
      kind: 'refuse',
      message: `daemon '${daemonName}' runs atc ${skew.daemonMajor}, older than the atc ${skew.contractMajor} protocol this gateway speaks; upgrade the daemon`,
    }))
    .with({ verdict: 'newer' }, (skew) => ({
      kind: 'refuse',
      message: `daemon '${daemonName}' runs atc ${skew.daemonMajor}, newer than the atc ${skew.contractMajor} protocol this gateway speaks; upgrade the gateway`,
    }))
    .with({ verdict: 'unreadable' }, (unreadable) => ({
      kind: 'warn',
      message: `daemon '${daemonName}' runs ${unreadable.daemon}, which names no version, so the gateway cannot check its protocol`,
    }))
    .exhaustive();
}
