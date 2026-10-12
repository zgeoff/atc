import { expect, test } from 'bun:test';
import { assertContractEvent } from './assert-contract-event';

test('it passes an event its contract parses unchanged', () => {
  expect(() => {
    assertContractEvent({ v: 4, ev: 'SessionResized', s: 's-1', cols: 80, rows: 24 });
  }).not.toThrow();
});

test('it throws for an event its contract refuses', () => {
  expect(() => {
    assertContractEvent({ v: 4, ev: 'SessionResized', s: 's-1', cols: 80 });
  }).toThrowWithMessage(Error, /^SessionResized event outside its contract/);
});

test('it throws for an event holding a field its contract drops', () => {
  expect(() => {
    assertContractEvent({ v: 4, ev: 'SessionResized', s: 's-1', cols: 80, rows: 24, dpi: 2 });
  }).toThrowWithMessage(Error, /^SessionResized event has fields its contract drops/);
});

test('it throws for an event name the contract does not define', () => {
  expect(() => {
    assertContractEvent({ v: 4, ev: 'SessionExploded', s: 's-1' });
  }).toThrowWithMessage(Error, /^SessionExploded event outside its contract/);
});
