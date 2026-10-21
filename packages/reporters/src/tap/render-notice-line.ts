interface NoticeLineFields {
  readonly message: string;
  readonly from: string;
  readonly status: 'answered' | 'unanswered';
  readonly answer?: string | undefined;
  readonly reason?: string | undefined;
}

export function renderNoticeLine(notice: NoticeLineFields): string {
  return `${JSON.stringify({
    // no `text` field, so a reader that takes only message lines skips it
    kind: 'answer',
    id: notice.message,
    from: notice.from,
    status: notice.status,
    ...(notice.answer === undefined ? {} : { answer: notice.answer }),
    ...(notice.reason === undefined ? {} : { reason: notice.reason }),
  })}\n`;
}
