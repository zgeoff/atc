import { posix } from 'node:path';
import { WORKSPACE_CLEANUP_SCHEMA } from '@atcx/contract';
import { match } from 'ts-pattern';

// What the overlay does with the daemon's answer to a forget: ask once more
// before the forget destroys the session's host, show a notice on the hint
// line, or nothing.
export type ForgetStep =
  | { readonly step: 'confirm' }
  | { readonly step: 'notice'; readonly notice: string }
  | { readonly step: 'none' };

export function pickForgetStep(answer: Readonly<Record<string, unknown>>): ForgetStep {
  if (typeof answer['confirmToken'] === 'string') {
    return { step: 'confirm' };
  }

  const workspace = WORKSPACE_CLEANUP_SCHEMA.safeParse(answer['workspace']);

  if (!workspace.success) {
    return { step: 'none' };
  }

  return match(workspace.data)
    .returnType<ForgetStep>()
    .with({ outcome: 'kept' }, (kept) => {
      // the path is one on the session's host, which atc reaches only over a
      // POSIX shell, so a client on another platform still splits it on `/`
      const folder = posix.basename(kept.path);

      return { step: 'notice', notice: `kept ${folder}: ${kept.reasons.join(', ')}` };
    })
    .with({ outcome: 'removed' }, { outcome: 'none' }, () => ({ step: 'none' }))
    .exhaustive();
}
