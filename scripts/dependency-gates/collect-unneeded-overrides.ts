import type { DependencyGateFinding, LockfileDependent } from './types.ts';

interface UnneededOverridesInput {
  readonly overrides: Readonly<Record<string, string>>;
  readonly catalog: Readonly<Record<string, string>>;
  readonly catalogs: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly dependents: readonly LockfileDependent[];
}

export function collectUnneededOverrides(input: UnneededOverridesInput): DependencyGateFinding[] {
  return Object.entries(input.overrides).flatMap(([name, pin]) => {
    const ranges = input.dependents
      .filter((dependent) => dependent.name === name)
      .map((dependent) => resolveCatalogRange(input, name, dependent.range));

    if (ranges.length === 0) {
      return [
        {
          path: 'package.json',
          entry: name,
          problem: 'no package in bun.lock depends on the overridden package',
        },
      ];
    }

    const isPinOutsideARange = ranges.some(
      (range) => !isSemverRange(range) || !Bun.semver.satisfies(pin, range),
    );

    const isPinTheCatalogVersion = input.catalog[name] === pin;

    if (isPinOutsideARange || isPinTheCatalogVersion) {
      return [];
    }

    return [
      {
        path: 'package.json',
        entry: name,
        problem: `every range in bun.lock already admits ${pin}, so the override changes nothing`,
      },
    ];
  });
}

// bun.lock keeps a workspace's `catalog:` reference as it is written in its package.json.
function resolveCatalogRange(input: UnneededOverridesInput, name: string, range: string): string {
  if (!range.startsWith('catalog:')) {
    return range;
  }

  const catalogName = range.slice('catalog:'.length);
  const catalog = catalogName === '' ? input.catalog : input.catalogs[catalogName];

  return catalog?.[name] ?? range;
}

const comparatorPattern =
  /^(?:[<>]=?|=|\^|~)?v?(?:\d+|[*Xx])(?:\.(?:\d+|[*Xx])){0,2}(?:-[\w.-]+)?(?:\+[\w.-]+)?$/u;

// Bun.semver.satisfies reads a range it cannot parse, such as a dist-tag, a `workspace:` or `npm:`
// protocol or a git URL, as any version, so only a range of plain comparators can admit the pin.
function isSemverRange(range: string): boolean {
  return range.split('||').every((part) =>
    part
      .trim()
      .split(/\s+/u)
      .every((token) => token === '' || token === '-' || comparatorPattern.test(token)),
  );
}
