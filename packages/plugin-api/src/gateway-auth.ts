/**
 * The auth profiles a gateway's sessions are bound to through impd's
 * broker, and the variables each session gets in place of a credential,
 * every value the fixed placeholder. `args`, when set, replaces the
 * gateway's arguments on a launch behind the broker, whose host lays out
 * its files apart from the daemon's.
 */
export interface GatewayAuth {
  readonly profiles: readonly string[];
  readonly placeholderEnv: Readonly<Record<string, string>>;
  readonly args?: readonly string[];
}
