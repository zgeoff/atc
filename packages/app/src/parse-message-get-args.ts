import type { MessageGetRequest, UsageResult } from './send-types';

// The `atc message get` arguments and flags as the command line parser hands
// them over.
interface MessageGetArgs {
  readonly message: string;
  readonly wait: boolean;
  readonly timeout: number | undefined;
  readonly daemon: string | undefined;
  readonly json: boolean;
}

const DEFAULT_TIMEOUT_SECONDS = 300;

export function parseMessageGetArgs(
  args: Readonly<MessageGetArgs>,
): UsageResult<MessageGetRequest> {
  if (args.timeout !== undefined && !args.wait) {
    return { ok: false, message: '--timeout needs --wait' };
  }

  return {
    ok: true,
    request: {
      message: args.message,
      wait: args.wait,
      timeoutSeconds: args.timeout ?? DEFAULT_TIMEOUT_SECONDS,
      daemon: args.daemon ?? null,
      json: args.json,
    },
  };
}
