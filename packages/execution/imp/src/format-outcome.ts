import { truncateSummary } from '@atc/core';
import { match } from 'ts-pattern';
import type { ImpSessionOutcome } from './imp-port';
import { sanitizeDetail } from './sanitize-detail';

// An end other than an exit, as a session's last message.
export function formatOutcome(outcome: Exclude<ImpSessionOutcome, { kind: 'exit' }>): string {
  return match(outcome)
    .with({ kind: 'failed' }, (ended) => {
      const code = ended.code ?? 'error';
      const detail = buildSafeDetail(ended.message);

      const line =
        detail === ''
          ? `imp refused the session (${code})`
          : `imp refused the session (${code}): ${detail}`;

      return truncateSummary(line);
    })
    .with({ kind: 'detached' }, (ended) => `imp detached the session (${ended.reason})`)
    .with({ kind: 'closed' }, (ended) => `imp connection closed (${ended.reason})`)
    .with({ kind: 'unreachable' }, () => 'imp unreachable')
    .with({ kind: 'unauthorized' }, () => 'imp refused the token')
    .with(
      { kind: 'local_error' },
      (ended) => `imp connection failed in the daemon (${ended.detail})`,
    )
    .with({ kind: 'bad_message' }, () => 'imp sent a bad message')
    .exhaustive();
}

// Credentials are redacted while line breaks still bound a header's value,
// then control characters go, so the text cannot redraw a list row.
function buildSafeDetail(message: string): string {
  return sanitizeDetail(message)
    .replaceAll(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replaceAll(/\s+/gu, ' ')
    .trim();
}
