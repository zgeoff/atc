// How an execution plugin's targets name the hosts they bind to: the version
// its identities carry, and the options that never select an existing host,
// which stay out of the identity so a change to one keeps every binding.
export interface TargetIdentityRule {
  readonly version: string;
  readonly ignoredOptions: readonly string[];
}
