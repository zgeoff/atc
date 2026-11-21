import { expect, test } from 'bun:test';
import { runChainedCommand } from './run-chained-command';

test('it gives back the output of the command, with its stdin', async () => {
  const output = await runChainedCommand('printf "line:"; cat', 'from-stdin');

  expect(output).toBe('line:from-stdin');
});

test('it gives back what the command wrote by its timeout when a child keeps stdout open', async () => {
  const startedAtMs = Date.now();

  const output = await runChainedCommand('printf partial; sleep 10 & wait', '');

  expect([output, Date.now() - startedAtMs]).toStrictEqual(['partial', expect.toBeWithin(0, 3000)]);
});
