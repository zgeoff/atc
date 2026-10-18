import type { BridgedNotice } from '@atc/plugin-api';
import { encodeAttribute } from './encode-attribute';

// the same notice the claude bridge delivers
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

// A message whose session ended before it answered reaches no one unless
// its sender sends it again, so the notice says so.
function renderNoticeAdvice(notice: BridgedNotice): string {
  return notice.status === 'unanswered' && notice.reason === 'session_ended'
    ? 'This message has no answer, because its session ended before it answered. Send it again if you still need the answer.'
    : '';
}
