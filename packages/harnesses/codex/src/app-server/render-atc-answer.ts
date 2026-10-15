import type { BridgedNotice } from '@atc/plugin-api';
import { encodeAttribute } from './encode-attribute';

/**
 * Renders the outcome of a message the session sent as the `<atc-answer>`
 * notice the model reads, the same notice the Claude bridge delivers.
 */
export function renderAtcAnswer(notice: BridgedNotice): string {
  const reason =
    notice.status === 'unanswered' && notice.reason !== undefined
      ? ` reason="${encodeAttribute(notice.reason)}"`
      : '';

  const body = (notice.answer ?? '').replaceAll('</atc-answer>', '&lt;/atc-answer&gt;');

  return `<atc-answer id="${encodeAttribute(notice.id)}" from="${encodeAttribute(notice.from)}" status="${encodeAttribute(notice.status)}"${reason}>\n${body}\n</atc-answer>`;
}
