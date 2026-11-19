import type { SendRequest, UsageResult } from './types';

export interface SendArgs {
  readonly session: string;
  readonly text: string | undefined;
  readonly key: string | undefined;
  readonly wait: boolean;
  readonly timeout: number | undefined;
  readonly from: string | undefined;
  readonly owner: boolean;
  readonly daemon: string | undefined;
  readonly json: boolean;
}

const DEFAULT_TIMEOUT_SECONDS = 300;

export function parseSendArgs(args: Readonly<SendArgs>): UsageResult<SendRequest> {
  const refusal = findSendRefusal(args);

  if (refusal !== null) {
    return { ok: false, message: refusal };
  }

  const from = args.from?.trim() ?? null;
  const readsStdin = args.text === undefined || args.text === '-';

  const text: SendRequest['text'] = readsStdin
    ? { kind: 'stdin', explicit: args.text === '-' }
    : { kind: 'literal', value: args.text ?? '' };

  return {
    ok: true,
    request: {
      session: args.session,
      text,
      key: args.key ?? null,
      wait: args.wait,
      timeoutSeconds: args.timeout ?? DEFAULT_TIMEOUT_SECONDS,
      from,
      owner: args.owner,
      daemon: args.daemon ?? null,
      json: args.json,
    },
  };
}

const MAX_KEY_LENGTH = 200;
const MAX_FROM_LENGTH = 200;

function findSendRefusal(args: Readonly<SendArgs>): string | null {
  if (args.timeout !== undefined && !args.wait) {
    return '--timeout needs --wait';
  }

  if (args.from !== undefined && args.owner) {
    return '--from conflicts with --owner';
  }

  if (args.daemon !== undefined && (args.from !== undefined || args.owner)) {
    return '--daemon conflicts with --from and --owner';
  }

  if (args.key !== undefined && (args.key.length === 0 || args.key.length > MAX_KEY_LENGTH)) {
    return `--key takes 1 to ${MAX_KEY_LENGTH} characters`;
  }

  if (args.from !== undefined) {
    const from = args.from.trim();

    if (from.length === 0 || from.length > MAX_FROM_LENGTH) {
      return `--from takes 1 to ${MAX_FROM_LENGTH} characters, once trimmed`;
    }
  }

  return args.text === undefined || args.text === '-' ? null : findTextRefusal(args.text);
}

const MAX_TEXT_BYTES = 256 * 1024;

export function findTextRefusal(text: string): string | null {
  if (text === '') {
    return 'the message text is empty';
  }

  if (new TextEncoder().encode(text).length > MAX_TEXT_BYTES) {
    return 'the message text is over 256 KiB';
  }

  return null;
}
