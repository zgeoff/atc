import { expect, test } from 'bun:test';
import { buildStubTerminal } from './build-stub-terminal';

test('it holds no text before anything is written', () => {
  expect(buildStubTerminal().getText()).toBe('');
});

test('it returns every chunk written, in order', () => {
  const terminal = buildStubTerminal();

  terminal.write('\u001B[2J');
  terminal.write('sessions');

  expect(terminal.getText()).toBe('\u001B[2Jsessions');
});

test('it drops the chunks written before a reset', () => {
  const terminal = buildStubTerminal();

  terminal.write('stale frame');
  terminal.reset();
  terminal.write('fresh frame');

  expect(terminal.getText()).toBe('fresh frame');
});
