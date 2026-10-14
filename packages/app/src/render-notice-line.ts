/**
 * The fields of one answer notice a tap prints: the message the session
 * sent, the session it was sent to, and how it ended.
 */
interface NoticeLineFields {
  readonly message: string;
  readonly from: string;
  readonly status: 'answered' | 'unanswered';
  readonly answer?: string | undefined;
  readonly reason?: string | undefined;
}

/**
 * The NDJSON line a tap prints for one answer notice, `kind` "answer". It
 * holds no `text` field, so a reader that takes only message lines skips
 * it.
 */
export function renderNoticeLine(notice: NoticeLineFields): string {
  return `${JSON.stringify({
    kind: 'answer',
    id: notice.message,
    from: notice.from,
    status: notice.status,
    ...(notice.answer === undefined ? {} : { answer: notice.answer }),
    ...(notice.reason === undefined ? {} : { reason: notice.reason }),
  })}\n`;
}
