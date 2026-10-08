import { expect, test } from 'bun:test';
import { createStubImpPort } from './create-stub-imp-port';
import { getOnlyImpName } from './get-only-imp-name';

// The stub port whose imps a test reads; every process it started is killed
// once the test finishes.
function setupTest() {
  const port = createStubImpPort();

  return { port };
}

test('it returns the name of the only imp', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'atc-one' });

  expect(getOnlyImpName(ctx.port)).toBe('atc-one');
});

test('it throws when the port holds no imp', () => {
  const ctx = setupTest();

  expect(() => getOnlyImpName(ctx.port)).toThrowWithMessage(Error, 'expected one imp, found []');
});

test('it throws when the port holds several imps', async () => {
  const ctx = setupTest();

  await ctx.port.createImp({ name: 'atc-one' });
  await ctx.port.createImp({ name: 'atc-two' });

  expect(() => getOnlyImpName(ctx.port)).toThrowWithMessage(
    Error,
    'expected one imp, found ["atc-one","atc-two"]',
  );
});
