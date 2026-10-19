import type { HarnessExit } from '@atc/plugin-api';
import { DaemonError } from '@atc/protocol/wire';
import { match } from 'ts-pattern';
import { z } from 'zod';
import { formatOutcome } from './format-outcome';
import type { ImpSessionOutcome } from './imp-port';

// How a refused precondition ends a harness: the exit, and the refusal its
// start settles with when impd gave a reason the daemon knows.
interface PreconditionRefusal {
  readonly refusal: DaemonError | null;
  readonly exit: HarnessExit;
}

// impd refuses a start whose broker is not ready.
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
        refusal: new DaemonError(
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

// impd's reason for a refused precondition, and its detail, each read on its
// own so a detail that is not text leaves the reason.
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
