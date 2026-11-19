import { lazy } from 'gunshi';
import { integer } from 'gunshi/combinators';
import { parseSendArgs } from '../send/parse-send-args';
import type { SendRequest } from '../send/types';
import { refuseCommandLine } from './run-command-line';
import type { CommandLineIO } from './run-command-line';

// The run the `atc send` command hands its parsed request to.
export interface SendCommandIO extends CommandLineIO {
  readonly runSend: (request: SendRequest) => Promise<void>;
}

export function createSendCommand(io: SendCommandIO) {
  return lazy(
    () => async (ctx) => {
      const parsed = parseSendArgs({
        session: ctx.values.session,
        text: ctx.values.text,
        key: ctx.values.key,
        wait: ctx.values.wait,
        timeout: ctx.values.timeout,
        from: ctx.values.from,
        owner: ctx.values.owner,
        daemon: ctx.values.daemon,
        json: ctx.values.json,
      });

      if (!parsed.ok) {
        await refuseCommandLine(io, ctx, parsed.message, 2);

        return;
      }

      await io.runSend(parsed.request);
    },
    {
      name: 'send',
      description:
        'Send a session a message from a script; with --wait, wait for its answer. Exits 0 sent or answered, 1 refused, 2 usage, 3 no session, 4 daemon not reached, 5 not delivered, 6 delivery unknown, 7 unanswered, 8 wait timed out',
      args: {
        session: { type: 'positional', description: 'The session id, or its exact name' },
        text: {
          type: 'positional',
          required: false,
          description: 'The message text; "-" or none reads stdin',
        },
        key: {
          type: 'string',
          description: 'The idempotency key, so a retry sends once (default: a new key, printed)',
        },
        wait: {
          type: 'boolean',
          default: false,
          description: 'Wait for the message to be answered',
        },
        timeout: integer({
          min: 1,
          description: 'With --wait, how many seconds to wait (default 300)',
        }),
        from: { type: 'string', description: 'The sender name of the message (default atc-send)' },
        owner: { type: 'boolean', default: false, description: 'Send as the owner' },
        daemon: {
          type: 'string',
          description: "Send to this daemon from the config's daemons map",
        },
        json: { type: 'boolean', default: false, description: 'Print one JSON object on stdout' },
      },
    },
  );
}
