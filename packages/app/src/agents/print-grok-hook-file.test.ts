import { expect, test } from 'bun:test';
import { printGrokHookFile } from './print-grok-hook-file';

test('it prints the Grok hook file that reports under the grok agent through the given atc', () => {
  const command = '"/usr/local/bin/atc" hook-report --agent grok';
  const printed: string[] = [];

  printGrokHookFile(['/usr/local/bin/atc'], (text) => {
    printed.push(text);
  });

  expect(printed.map((text): unknown => JSON.parse(text))).toStrictEqual([
    {
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command, timeout: 5 }] }],
        SessionEnd: [{ hooks: [{ type: 'command', command, timeout: 5 }] }],
        UserPromptSubmit: [{ hooks: [{ type: 'command', command, timeout: 5 }] }],
        Stop: [{ hooks: [{ type: 'command', command, timeout: 5 }] }],
        StopFailure: [{ hooks: [{ type: 'command', command, timeout: 5 }] }],
        StopCancelled: [{ hooks: [{ type: 'command', command, timeout: 5 }] }],
        Notification: [{ hooks: [{ type: 'command', command, timeout: 5 }] }],
      },
    },
  ]);
});
