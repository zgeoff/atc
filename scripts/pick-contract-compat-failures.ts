import type { ContractChange } from './collect-contract-changes';

export interface InputFieldLists {
  // Each input field that changes behaviour, with the feature a daemon must list.
  readonly features: Readonly<Record<string, Readonly<Record<string, string>>>>;

  // Each input field that changes no behaviour, with the reason.
  readonly harmless: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

export function pickContractCompatFailures(
  changes: readonly ContractChange[],
  lists: InputFieldLists,
  isBreakingMarked: boolean,
): string[] {
  const failures: string[] = [];

  for (const change of changes) {
    const where = change.path === '' ? change.method : `${change.method} ${change.path}`;

    if (change.kind === 'breaking') {
      if (!isBreakingMarked) {
        failures.push(`${where}: ${change.message}`);
      }

      continue;
    }

    const isListed =
      lists.features[change.method]?.[change.path] !== undefined ||
      (lists.harmless[change.method]?.[change.path] ?? '') !== '';

    if (!isListed) {
      failures.push(
        `${where}: a new input field with neither a FEATURE_INPUT_FIELDS entry nor a harmless-field entry`,
      );
    }
  }

  return failures;
}
