import { expect, test } from 'bun:test';
import { pickContractCompatFailures } from './pick-contract-compat-failures';

test('it fails a breaking change that no commit marks', () => {
  const failures = pickContractCompatFailures(
    [
      {
        kind: 'breaking',
        method: 'session.spawn',
        path: 'cwd',
        message: 'input: the field is removed or renamed',
      },
    ],
    { features: {}, harmless: {} },
    false,
  );

  expect(failures).toStrictEqual(['session.spawn cwd: input: the field is removed or renamed']);
});

test('it passes a breaking change that a commit marks', () => {
  const failures = pickContractCompatFailures(
    [
      {
        kind: 'breaking',
        method: 'session.spawn',
        path: 'cwd',
        message: 'input: the field is removed or renamed',
      },
    ],
    { features: {}, harmless: {} },
    true,
  );

  expect(failures).toStrictEqual([]);
});

test('it fails a new input field with no entry, even when a commit marks a breaking change', () => {
  const failures = pickContractCompatFailures(
    [{ kind: 'new-input-field', method: 'session.spawn', path: 'region', message: 'new' }],
    { features: {}, harmless: {} },
    true,
  );

  expect(failures).toStrictEqual([
    'session.spawn region: a new input field with neither a FEATURE_INPUT_FIELDS entry nor a harmless-field entry',
  ]);
});

test('it passes a new input field that FEATURE_INPUT_FIELDS lists', () => {
  const failures = pickContractCompatFailures(
    [{ kind: 'new-input-field', method: 'session.spawn', path: 'region', message: 'new' }],
    { features: { 'session.spawn': { region: 'session.region' } }, harmless: {} },
    false,
  );

  expect(failures).toStrictEqual([]);
});

test('it passes a new input field that the harmless list explains', () => {
  const failures = pickContractCompatFailures(
    [{ kind: 'new-input-field', method: 'session.spawn', path: 'region', message: 'new' }],
    { features: {}, harmless: { 'session.spawn': { region: 'a label the daemon only logs' } } },
    false,
  );

  expect(failures).toStrictEqual([]);
});

test('it fails a new input field whose harmless entry has no reason', () => {
  const failures = pickContractCompatFailures(
    [{ kind: 'new-input-field', method: 'session.spawn', path: 'region', message: 'new' }],
    { features: {}, harmless: { 'session.spawn': { region: '' } } },
    false,
  );

  expect(failures).toHaveLength(1);
});
