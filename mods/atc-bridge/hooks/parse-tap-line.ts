const SENDER_KINDS = ['connector', 'session', 'local', 'owner'] as const;

// Who sent a message, as atc built it from the caller: its kind, and the atc
// id of a session that sent it.
export interface TapSender {
  readonly kind: (typeof SENDER_KINDS)[number];
  readonly session: string | undefined;
}

export interface TapMessage {
  readonly id: string;
  readonly from: string;
  readonly sender: TapSender | undefined;
  readonly text: string;
}

const NOTICE_STATUSES = ['answered', 'unanswered'] as const;

export interface TapNotice {
  readonly id: string;
  readonly from: string;
  readonly status: (typeof NOTICE_STATUSES)[number];
  readonly answer: string | undefined;
  readonly reason: string | undefined;
}

type TapItem =
  | { readonly kind: 'message'; readonly msg: TapMessage }
  | { readonly kind: 'answer'; readonly notice: TapNotice };

export function parseTapLine(line: string): TapItem | null {
  let parsed: unknown;

  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }

  // A line that declares a kind is never a message, whatever else it holds.
  if ('kind' in parsed) {
    const notice = parsed.kind === 'answer' ? parseTapNotice(parsed) : null;

    return notice === null ? null : { kind: 'answer', notice };
  }

  if (!('id' in parsed) || !('from' in parsed) || !('text' in parsed)) {
    return null;
  }

  if (
    typeof parsed.id !== 'string' ||
    typeof parsed.from !== 'string' ||
    typeof parsed.text !== 'string'
  ) {
    return null;
  }

  const sender = 'sender' in parsed ? parseTapSender(parsed.sender) : undefined;

  return { kind: 'message', msg: { id: parsed.id, from: parsed.from, sender, text: parsed.text } };
}

// A sender this mod cannot read is left out, and the message still goes out
// with its sender's name.
function parseTapSender(value: unknown): TapSender | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }

  const fields: Record<string, unknown> = { ...value };
  const { kind, session } = fields;

  if (typeof kind !== 'string' || !isSenderKind(kind)) {
    return undefined;
  }

  if (kind !== 'session') {
    return { kind, session: undefined };
  }

  return typeof session === 'string' ? { kind, session } : undefined;
}

function isSenderKind(value: string): value is TapSender['kind'] {
  return SENDER_KINDS.some((kind) => kind === value);
}

function parseTapNotice(parsed: object): TapNotice | null {
  const fields: Record<string, unknown> = { ...parsed };
  const { id, from, status, answer, reason } = fields;

  if (
    typeof id !== 'string' ||
    typeof from !== 'string' ||
    typeof status !== 'string' ||
    !isNoticeStatus(status) ||
    (answer !== undefined && typeof answer !== 'string') ||
    (reason !== undefined && typeof reason !== 'string')
  ) {
    return null;
  }

  return { id, from, status, answer, reason };
}

function isNoticeStatus(value: string): value is TapNotice['status'] {
  return NOTICE_STATUSES.some((status) => status === value);
}
