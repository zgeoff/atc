import { expect, test } from 'bun:test';
import { formatTerminalRestore } from './format-terminal-restore';

test('#formatTerminalRestore sends no kitty sequence to a terminal without the protocol', () => {
  const restore = formatTerminalRestore(false);

  expect([restore.includes('\u001B[<u'), restore.includes('\u001B[=')]).toStrictEqual([
    false,
    false,
  ]);
});

test('#formatTerminalRestore clears the kitty flags with a set, never a pop', () => {
  const restore = formatTerminalRestore(true);

  expect([restore.includes('\u001B[=0u'), restore.includes('\u001B[<u')]).toStrictEqual([
    true,
    false,
  ]);
});
