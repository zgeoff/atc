import { expect, test } from 'bun:test';
import { toSessionID } from '@atcx/contract';
import { buildMockNewMaterialization } from './build-mock-new-materialization';

test('it builds a default new materialization on the local target', () => {
  expect(buildMockNewMaterialization()).toStrictEqual({
    sessionID: expect.toBeString(),
    target: 'local',
    directory: expect.toStartWith('/'),
    sourceKind: 'git',
    withheldEnv: [],
  });
});

test('it applies overrides on top of the defaults', () => {
  expect(
    buildMockNewMaterialization({
      sessionID: toSessionID('s-kept'),
      target: 'box',
      directory: '/work/bakery',
      sourceKind: 'path',
      withheldEnv: ['GIT_ASKPASS'],
    }),
  ).toStrictEqual({
    sessionID: toSessionID('s-kept'),
    target: 'box',
    directory: '/work/bakery',
    sourceKind: 'path',
    withheldEnv: ['GIT_ASKPASS'],
  });
});
