import { expect, test } from 'bun:test';
import { toSessionID } from '@atc/core';
import { readPeerSession } from './read-peer-session';

test('it finds the session whose harness is the peer itself', () => {
  const harnesses = new Map([[40, toSessionID('s-1')]]);

  expect(readPeerSession(40, harnesses, () => null)).toBe(toSessionID('s-1'));
});

test('it finds the session whose harness is a grandparent of the peer', () => {
  const harnesses = new Map([[40, toSessionID('s-1')]]);

  const parents = new Map([
    [42, 41],
    [41, 40],
    [40, 1],
  ]);

  expect(readPeerSession(42, harnesses, (pid) => parents.get(pid) ?? null)).toBe(
    toSessionID('s-1'),
  );
});

test('it finds the nearest harness when one runs below another', () => {
  const harnesses = new Map([
    [40, toSessionID('s-parent')],
    [51, toSessionID('s-child')],
  ]);

  const parents = new Map([
    [52, 51],
    [51, 40],
    [40, 1],
  ]);

  expect(readPeerSession(52, harnesses, (pid) => parents.get(pid) ?? null)).toBe(
    toSessionID('s-child'),
  );
});

test('it finds no session for a process whose chain reaches init without a harness', () => {
  const harnesses = new Map([[40, toSessionID('s-1')]]);

  const parents = new Map([
    [62, 61],
    [61, 1],
  ]);

  expect(readPeerSession(62, harnesses, (pid) => parents.get(pid) ?? null)).toBeNull();
});

test('it finds no session when a parent in the chain is gone', () => {
  const harnesses = new Map([[40, toSessionID('s-1')]]);

  expect(readPeerSession(72, harnesses, () => null)).toBeNull();
});

test('it stops a walk whose parent chain loops', () => {
  const harnesses = new Map([[40, toSessionID('s-1')]]);

  const parents = new Map([
    [82, 81],
    [81, 82],
  ]);

  expect(readPeerSession(82, harnesses, (pid) => parents.get(pid) ?? null)).toBeNull();
});
