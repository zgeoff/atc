export interface GatewayAuth {
  readonly profiles: readonly string[];

  // every value the fixed placeholder.
  readonly placeholderEnv: Readonly<Record<string, string>>;

  // replaces the gateway's arguments on a launch behind the broker, whose
  // host lays out its files apart from the daemon's.
  readonly args?: readonly string[];
}
