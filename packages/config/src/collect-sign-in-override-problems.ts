// The variables an entry that signs in through the target's broker sets in
// each env source, where the kind's own check names one that would override
// that sign-in or route the CLI around the broker.
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
