import { expect, test } from 'bun:test';
import { pickConflictKind } from './pick-conflict-kind';

test.each([
  ['{"message":"removal of container atc-c1 is already in progress"}', 'removal-in-progress'],
  ['{"message":"remove atc-v1: volume is in use - [4f2a9c]"}', 'volume-in-use'],
  ['{"message":"container atc-c1 is locked"}', 'other'],
  [
    '{"message":"container atc-c1 is locked","detail":"removal of container atc-c1 is already in progress"}',
    'other',
  ],
  ['removal of container atc-c1 is already in progress', 'other'],
] as const)('it reads the conflict %s as %s', (body, kind) => {
  expect(pickConflictKind(body)).toBe(kind);
});
