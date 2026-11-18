import { expect, test } from 'bun:test';
import { buildMockImpSessionRequest } from './build-mock-imp-session-request';

test('it builds a default imp session request', () => {
  expect(buildMockImpSessionRequest()).toStrictEqual({
    kind: 'start',
    name: expect.toStartWith('imp-'),
    session: expect.toBeString(),
    argv: ['true'],
    env: {},
    cwd: expect.toBeString(),
    cols: expect.toBeNumber(),
    rows: expect.toBeNumber(),
  });
});

test('it builds a default attach request for an override of kind attach', () => {
  expect(buildMockImpSessionRequest({ kind: 'attach' })).toStrictEqual({
    kind: 'attach',
    name: expect.toStartWith('imp-'),
    session: expect.toBeString(),
    cols: expect.toBeNumber(),
    rows: expect.toBeNumber(),
    wake: false,
  });
});

test('it applies overrides on top of the defaults', () => {
  expect(
    buildMockImpSessionRequest({
      name: 'imp-a',
      argv: ['sleep', '30'],
      cols: 80,
      require: ['broker'],
    }),
  ).toStrictEqual({
    kind: 'start',
    name: 'imp-a',
    session: expect.toBeString(),
    argv: ['sleep', '30'],
    env: {},
    cwd: expect.toBeString(),
    cols: 80,
    rows: expect.toBeNumber(),
    require: ['broker'],
  });
});
