import type { BridgedNotice } from '@atc/plugin-api';
import { encodeAttribute } from './encode-attribute';

export function renderAtcAnswer(notice: BridgedNotice): string {
  const reason =
    notice.status === 'unanswered' && notice.reason !== undefined
      ? ` reason="${encodeAttribute(notice.reason)}"`
      : '';

  const body = (notice.answer ?? renderNoticeAdvice(notice)).replaceAll(
    '</atc-answer>',
    '&lt;/atc-answer&gt;',
  );

  return `<atc-answer id="${encodeAttribute(notice.id)}" from="${encodeAttribute(notice.from)}" status="${encodeAttribute(notice.status)}"${reason}>\n${body}\n</atc-answer>`;
}

function renderNoticeAdvice(notice: BridgedNotice): string {
  return notice.status === 'unanswered' && notice.reason === 'session_ended'
    ? 'This message has no answer, because its session ended before it answered. Send it again if you still need the answer.'
    : '';
}
