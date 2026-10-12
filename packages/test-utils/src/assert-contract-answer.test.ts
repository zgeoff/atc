import { expect, test } from 'bun:test';
import { assertContractAnswer } from './assert-contract-answer';

test('it passes an answer its contract parses unchanged', () => {
  expect(() => {
    assertContractAnswer('session.screen', { text: 'hi', cols: 80, rows: 24 });
  }).not.toThrow();
});

test('it throws for an answer its contract refuses', () => {
  expect(() => {
    assertContractAnswer('session.screen', { text: 'hi', cols: 80 });
  }).toThrowWithMessage(Error, /^session\.screen answered outside its contract/);
});

test('it throws for an answer holding a field its contract drops', () => {
  expect(() => {
    assertContractAnswer('session.screen', { text: 'hi', cols: 80, rows: 24, cursor: 3 });
  }).toThrowWithMessage(Error, /^session\.screen answered fields its contract drops/);
});

test('it passes any answer to a method the contract does not define', () => {
  expect(() => {
    assertContractAnswer('daemon.nuke', { anything: true });
  }).not.toThrow();
});
