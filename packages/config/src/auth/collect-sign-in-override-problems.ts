export function collectSignInOverrideProblems(
  sources: readonly (readonly [string, readonly string[]])[],
  isOverride: (key: string) => boolean,
): string[] {
  return sources.flatMap(([source, keys]) =>
    keys
      .filter((key) => isOverride(key))
      .map(
        (key) =>
          `${source} must not set ${key}, which would override or route around the subscription sign-in`,
      ),
  );
}
