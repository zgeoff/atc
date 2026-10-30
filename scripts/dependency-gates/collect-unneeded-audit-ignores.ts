import type { AuditAdvisory, DependencyGateFinding } from './types.ts';

interface UnneededAuditIgnoresInput {
  readonly ignoreIDs: readonly string[];
  readonly advisories: readonly AuditAdvisory[];
  readonly fixablePackages: readonly string[];
}

export function collectUnneededAuditIgnores(
  input: UnneededAuditIgnoresInput,
): DependencyGateFinding[] {
  return input.ignoreIDs.flatMap((ignoreID) => {
    const matches = input.advisories.filter((advisory) => advisory.advisoryIDs.includes(ignoreID));

    if (matches.length === 0) {
      return [
        {
          path: 'package.json',
          entry: ignoreID,
          problem: 'no locked package has the ignored advisory',
        },
      ];
    }

    const fixable = matches.find((advisory) =>
      input.fixablePackages.includes(advisory.packageName),
    );

    if (fixable !== undefined) {
      return [
        {
          path: 'package.json',
          entry: ignoreID,
          problem: `bun audit fix can move ${fixable.packageName} to a patched release in range`,
        },
      ];
    }

    return [];
  });
}
