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

test('it returns only the chunks written after a mark', () => {
  const terminal = buildStubTerminal();

  terminal.write('stale frame');

  const mark = terminal.mark();

  terminal.write('fresh ');
  terminal.write('frame');

  expect(terminal.getTextSince(mark)).toBe('fresh frame');
});

test('it returns no text since a mark when nothing is written after it', () => {
  const terminal = buildStubTerminal();

  terminal.write('stale frame');

  const mark = terminal.mark();

  expect(terminal.getTextSince(mark)).toBe('');
});
