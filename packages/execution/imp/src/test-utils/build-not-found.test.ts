import { expect, test } from 'bun:test';
import { ImpPortError } from '../imp-port-error';
import { buildNotFound } from './build-not-found';

test('it builds an imp port error', () => {
  expect(buildNotFound('imps.sleep', 'imp-a')).toBeInstanceOf(ImpPortError);
});

test('it names the imp impd does not hold', () => {
  expect(buildNotFound('grants.list', 'imp-a')).toMatchObject({
    code: 'NOT_FOUND',
    data: { kind: 'imp', name: 'imp-a' },
    message: 'no imp imp-a',
  });
});
