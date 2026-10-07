/**
 * Every variable an entry's `env` or `settings.env` sets that one of its
 * selected auth profiles also sets, which would win over or lose to the
 * profile's value by order. `owners` maps each profile variable to the
 * profile that sets it.
 */
export function collectProfileEnvProblems(
  sources: readonly (readonly [string, readonly string[]])[],
  owners: Readonly<Record<string, string>>,
): string[] {
  return sources.flatMap(([source, keys]) =>
    keys
      .filter((key) => owners[key] !== undefined)
      .map((key) => `${source} sets ${key}, which auth profile ${owners[key]} sets`),
  );
}
