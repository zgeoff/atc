import type { createStubImpPort } from './create-stub-imp-port';

export function getOnlyImpName(
  port: Readonly<Pick<ReturnType<typeof createStubImpPort>, 'collectImpNames'>>,
): string {
  const names = port.collectImpNames();
  const [name] = names;

  if (names.length !== 1 || name === undefined) {
    throw new Error(`expected one imp, found ${JSON.stringify(names)}`);
  }

  return name;
}
