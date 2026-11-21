import { expect, test } from 'bun:test';
import { buildStubClock } from '@atc/core/test-utils/build-stub-clock';
import { createTerminalFacts } from './create-terminal-facts';

function setupTest(colorterm?: string) {
  const clock = buildStubClock(0);
  const written: string[] = [];
  let changes = 0;

  const facts = createTerminalFacts({
    env: { colorterm, term: 'xterm' },
    clock,
    write: (chunk) => {
      written.push(chunk);
    },
    onChange: () => {
      changes += 1;
    },
  });

  return {
    clock,
    facts,
    written,
    readChanges: () => changes,
  };
}

test('#read gives the fallbacks before any answer', () => {
  const ctx = setupTest('truecolor');

  expect(ctx.facts.read()).toStrictEqual({
    depth: 'truecolor',
    background: { red: 13, green: 17, blue: 23 },
    foreground: { red: 201, green: 209, blue: 217 },
    kittyKeyboard: false,
  });
});

test('#start asks for the colours, the keyboard protocol and the device attributes', () => {
  const ctx = setupTest();

  ctx.facts.start();

  expect(ctx.written).toStrictEqual(['\u001B]10;?\u001B\\\u001B]11;?\u001B\\\u001B[?u\u001B[c']);
});

test('#apply takes the answers that arrive in time and reports each change', () => {
  const ctx = setupTest();

  ctx.facts.start();
  ctx.facts.apply({ kind: 'background', colour: { red: 1, green: 2, blue: 3 } });
  ctx.facts.apply({ kind: 'foreground', colour: { red: 4, green: 5, blue: 6 } });
  ctx.facts.apply({ kind: 'kitty' });

  expect([ctx.facts.read(), ctx.readChanges()]).toStrictEqual([
    {
      depth: '16',
      background: { red: 1, green: 2, blue: 3 },
      foreground: { red: 4, green: 5, blue: 6 },
      kittyKeyboard: true,
    },
    3,
  ]);
});

test('#apply ignores an answer that arrives after 150 ms', () => {
  const ctx = setupTest();

  ctx.facts.start();
  ctx.clock.advance(151);
  ctx.facts.apply({ kind: 'kitty' });

  expect([ctx.facts.read().kittyKeyboard, ctx.readChanges()]).toStrictEqual([false, 0]);
});

test('#apply stops waiting at the device attributes answer', () => {
  const ctx = setupTest();

  ctx.facts.start();
  ctx.facts.apply({ kind: 'attributes' });
  ctx.facts.apply({ kind: 'kitty' });

  expect(ctx.facts.read().kittyKeyboard).toBe(false);
});
