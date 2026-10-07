import type { buildStubImpPort } from './build-stub-imp-port';

/**
 * Returns the name of the one imp a stub imp port holds, and throws when
 * it holds none or several, so a test that expects one spawn's imp never
 * reads another's.
 */
export function getOnlyImpName(
  port: Readonly<Pick<ReturnType<typeof buildStubImpPort>, 'collectImpNames'>>,
): string {
  const names = port.collectImpNames();
  const [name] = names;

  if (names.length !== 1 || name === undefined) {
    throw new Error(`expected one imp, found ${JSON.stringify(names)}`);
  }

  return name;
}
