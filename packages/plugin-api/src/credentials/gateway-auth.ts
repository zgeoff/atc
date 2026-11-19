export interface GatewayAuth {
  readonly profiles: readonly string[];

  readonly placeholderEnv: Readonly<Record<string, string>>;

  readonly args?: readonly string[];
}
