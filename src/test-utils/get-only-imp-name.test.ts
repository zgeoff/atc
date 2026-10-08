import { expect, test } from 'bun:test';
import { createStubImpPort } from './create-stub-imp-port';
import { getOnlyImpName } from './get-only-imp-name';

// The stub port whose imps a test reads; disposal kills every process it
// started.
function setupTest() {
  using stack = new DisposableStack();

  const port = stack.use(createStubImpPort());
  const owned = stack.move();

  return {
    port,
    [Symbol.dispose]: () => {
      owned.dispose();
    },
  };
}

test('it returns the name of the only imp', async () => {
  using ctx = setupTest();

  await ctx.port.createImp({ name: 'atc-one' });

  expect(getOnlyImpName(ctx.port)).toBe('atc-one');
});

test('it throws when the port holds no imp', () => {
  using ctx = setupTest();

  expect(() => getOnlyImpName(ctx.port)).toThrowWithMessage(Error, 'expected one imp, found []');
});

test('it throws when the port holds several imps', async () => {
  using ctx = setupTest();

  await ctx.port.createImp({ name: 'atc-one' });
  await ctx.port.createImp({ name: 'atc-two' });

  expect(() => getOnlyImpName(ctx.port)).toThrowWithMessage(
    Error,
    'expected one imp, found ["atc-one","atc-two"]',
  );
});
