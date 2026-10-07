import { expect, test } from 'bun:test';
import { FixtureImpPort } from './fixture-imp-port';
import { getOnlyImpName } from './get-only-imp-name';

test('it returns the name of the only imp', async () => {
  using port = new FixtureImpPort();

  await port.createImp({ name: 'atc-one' });

  expect(getOnlyImpName(port)).toBe('atc-one');
});

test('it throws when the port holds no imp', () => {
  using port = new FixtureImpPort();

  expect(() => getOnlyImpName(port)).toThrow('expected one imp, found []');
});

test('it throws when the port holds several imps', async () => {
  using port = new FixtureImpPort();

  await port.createImp({ name: 'atc-one' });
  await port.createImp({ name: 'atc-two' });

  expect(() => getOnlyImpName(port)).toThrow('expected one imp, found ["atc-one","atc-two"]');
});
