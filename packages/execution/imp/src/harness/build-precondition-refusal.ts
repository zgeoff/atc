import type { HarnessExit } from '@atc/plugin-api';
import { AtcError } from '@atcx/contract/light';
import { match } from 'ts-pattern';
import { z } from 'zod';
import type { ImpSessionOutcome } from '../port/imp-port';
import { formatOutcome } from './format-outcome';

interface PreconditionRefusal {
  readonly refusal: AtcError | null;
  readonly exit: HarnessExit;
}

export function buildPreconditionRefusal(
  outcome: Extract<ImpSessionOutcome, { kind: 'failed' }>,
  name: string,
): PreconditionRefusal {
  const data = parsePrecondition(outcome.data);

  return match(data.reason)
    .returnType<PreconditionRefusal>()
    .with('broker_not_ready', () => {
      const detail = data.detail ?? 'no detail';

      return {
        refusal: new AtcError(
          'broker_not_ready',
          `imp ${name} refused to start the harness: its credential broker is not ready (${detail})`,
          { imp: name, detail },
        ),
        exit: { exitCode: 1, reason: 'ended', detail: `imp broker not ready (${detail})` },
      };
    })
    .otherwise(() => ({
      refusal: null,
      exit: { exitCode: 1, reason: 'ended', detail: formatOutcome(outcome) },
    }));
}

// Parse impd's reason apart from its detail, so a detail that is not text
// does not make us lose the reason.
const PRECONDITION_REASON_SCHEMA = z.object({ reason: z.string() });
const PRECONDITION_DETAIL_SCHEMA = z.object({ detail: z.string() });

function parsePrecondition(data: unknown): { reason?: string; detail?: string } {
  const reason = PRECONDITION_REASON_SCHEMA.safeParse(data);
  const detail = PRECONDITION_DETAIL_SCHEMA.safeParse(data);

  return {
    ...(reason.success && { reason: reason.data.reason }),
    ...(detail.success && { detail: detail.data.detail }),
  };
}
