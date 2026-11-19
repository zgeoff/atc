interface NoticeLineFields {
  readonly message: string;
  readonly from: string;
  readonly status: 'answered' | 'unanswered';
  readonly answer?: string | undefined;
  readonly reason?: string | undefined;
}

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
