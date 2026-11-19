import { define, lazy } from 'gunshi';
import { integer } from 'gunshi/combinators';
import { parseMessageGetArgs } from '../message-get/parse-message-get-args';
import { makeMissingCommandRun, refuseCommandLine } from './run-command-line';
import type { MessageCommandIO } from './types';

export function createMessageCommand(io: MessageCommandIO) {
  return define({
    name: 'message',
    description: 'Read a message sent to a session',
    subCommands: {
      get: lazy(
        () => async (ctx) => {
          const parsed = parseMessageGetArgs({
            message: ctx.values.message,
            wait: ctx.values.wait,
            timeout: ctx.values.timeout,
            daemon: ctx.values.daemon,
            json: ctx.values.json,
          });

          if (!parsed.ok) {
            await refuseCommandLine(io, ctx, parsed.message, 2);

            return;
          }

          await io.runMessageGet(parsed.request);
        },
        {
          name: 'get',
          description:
            "Print a message's status and answer; with --wait, wait for the answer. Exits 0 queued, delivered or answered, 1 refused, 2 usage, 4 daemon not reached, 7 unanswered, 8 wait timed out",
          args: {
            message: { type: 'positional', description: 'The message id' },
            wait: {
              type: 'boolean',
              default: false,
              description: 'Wait for the message to be answered',
            },
            timeout: integer({
              min: 1,
              description: 'With --wait, how many seconds to wait (default 300)',
            }),
            daemon: {
              type: 'string',
              description: "Read from this daemon from the config's daemons map",
            },
            json: {
              type: 'boolean',
              default: false,
              description: 'Print the message as one JSON object on stdout',
            },
          },
        },
      ),
    },
    run: makeMissingCommandRun(io),
  });
}
