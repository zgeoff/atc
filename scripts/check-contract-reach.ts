import { isBuiltin } from 'node:module';

// One entry of @atcx/contract: whether its file exists, each file it reaches
// with the specifiers that file imports, and its unresolved imports.
export interface ContractEntry {
  readonly entry: string;
  readonly exists: boolean;
  readonly imports: ReadonlyMap<string, readonly string[]>;
  readonly unresolved: readonly string[];
}

const CONTRACT_SOURCE = 'packages/contract/src';

// npm installs @atcx/contract with only the packages it depends on, so
// nothing its entries reach may leave the package or import any other. A
// type-only import counts too, because the published declarations keep it.
export function checkContractReach(entries: readonly ContractEntry[]): string[] {
  return entries.flatMap((contractEntry) => {
    if (!contractEntry.exists) {
      return [`missing contract entry: ${contractEntry.entry} does not exist`];
    }

    const findings = [...contractEntry.imports.keys()].toSorted().flatMap((file) => {
      if (!file.startsWith(`${CONTRACT_SOURCE}/`)) {
        return [
          `unpublished module: ${contractEntry.entry} reaches ${file}, which npm never holds`,
        ];
      }

      return (contractEntry.imports.get(file) ?? [])
        .filter((specifier) => !isContractImport(specifier))
        .map(
          (specifier) =>
            `undeclared package: ${file} imports ${specifier}, which @atcx/contract does not depend on`,
        );
    });

    return [...findings, ...contractEntry.unresolved];
  });
}

const CONTRACT_PACKAGES: ReadonlySet<string> = new Set(['zod', '@orpc/contract']);

function isContractImport(specifier: string): boolean {
  return specifier.startsWith('.') || isBuiltin(specifier) || CONTRACT_PACKAGES.has(specifier);
}
