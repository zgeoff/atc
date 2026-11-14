import { z } from 'zod';

const refSchema = z.object({ ref: z.string().min(1) });

const pullRequestSchema = z.object({
  body: z.string().nullable(),
  base: refSchema,
  head: refSchema,
});

const pullRequestEventSchema = z.object({ pull_request: pullRequestSchema });

export type GateStep =
  | { readonly kind: 'skip'; readonly reason: string }
  | { readonly kind: 'gate'; readonly baseRef: string; readonly body: string }
  | { readonly kind: 'refused'; readonly message: string };

// What the `verify / gate` step does for one pull_request event. release-please opens its pull
// request from a `release-please--` branch: it changes only versions and changelogs, and nobody
// runs a journey on it, so its body never holds a report.
export function pickGateStep(event: unknown): GateStep {
  const parsed = pullRequestEventSchema.safeParse(event);

  if (!parsed.success) {
    return {
      kind: 'refused',
      message: 'the event holds no pull request; run this on pull_request',
    };
  }

  const pullRequest = parsed.data.pull_request;

  if (pullRequest.head.ref.startsWith('release-please--')) {
    return { kind: 'skip', reason: 'a release pull request carries no verify report' };
  }

  return { kind: 'gate', baseRef: pullRequest.base.ref, body: pullRequest.body ?? '' };
}
