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
