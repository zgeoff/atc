// Ignored options never select an existing host, so they stay out of the identity:
// changing one of them must keep every existing binding.
export interface TargetIdentityRule {
  readonly version: string;
  readonly ignoredOptions: readonly string[];
}
