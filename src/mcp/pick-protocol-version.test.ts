import { expect, test } from 'bun:test';
import { pickProtocolVersion } from './pick-protocol-version';

test.each([
  ['2025-11-25', '2025-11-25'],
  ['2025-06-18', '2025-06-18'],
  ['2025-03-26', '2025-03-26'],
  ['2026-07-28', '2025-11-25'],
  ['2024-11-05', '2025-11-25'],
  [undefined, '2025-11-25'],
  [20_250_618, '2025-11-25'],
])('it answers a requested version of %p with %p', (requested, expected) => {
  expect(pickProtocolVersion(requested)).toBe(expected);
});
