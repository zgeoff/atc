import type { ImpFeatures } from './imp-port';
import type { ImpdOutput } from './impd-contract';

/**
 * impd's capability flags in the port's terms. A flag counts only as a
 * literal true: an impd from before a flag has it false, and so does one
 * that sends anything else in its place.
 */
export function toImpFeatures(info: Pick<ImpdOutput<'system.info'>, 'features'>): ImpFeatures {
  const features: Readonly<Record<string, unknown>> | undefined = info.features;

  return {
    sessionOffsets: features?.['sessionOffsets'] === true,
    leases: features?.['leases'] === true,
    grantableTokens: features?.['grantableTokens'] === true,
    secretRebind: features?.['secretRebind'] === true,
    execRequire: features?.['execRequire'] === true,
    oauthSecrets: features?.['oauthSecrets'] === true,
    readOnlyFiles: features?.['readOnlyFiles'] === true,
    execDropSysAdmin: features?.['execDropSysAdmin'] === true,
  };
}
