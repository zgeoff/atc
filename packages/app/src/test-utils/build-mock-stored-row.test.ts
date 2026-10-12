import { expect, test } from 'bun:test';
import { buildMockStoredRow } from './build-mock-stored-row';

test('it builds a default stored row', () => {
  expect(buildMockStoredRow()).toStrictEqual({
    id: expect.toBeString(),
    name: expect.toBeString(),
    exited: false,
    agentSessionID: null,
  });
});

test('it applies overrides on top of the defaults', () => {
  expect(
    buildMockStoredRow({ id: 's-kept', exited: true, agentSessionID: 'c-kept' }),
  ).toStrictEqual({
    id: 's-kept',
    name: expect.toBeString(),
    exited: true,
    agentSessionID: 'c-kept',
  });
});
