import { COMMIT_ID_PATTERN } from '@atc/core';
import type { RequestOutcome } from './create-picker-actors';
import { formatPickerError } from './format-picker-error';
import { openConfirmStep, renderFlow, sendPending } from './navigate-picker';
import type { ChosenRef, PickerFlow, ProbedRepo } from './picker-flow';
import { buildTargetParam } from './picker-params';
import { collectRefItems } from './picker-queries';

const SHORT_SHA_PATTERN = /^[\da-f]{7,63}$/u;

export function applyRefSubmit(flow: PickerFlow) {
  const ctx = flow.ctx;
  const typed = ctx.input.trim();
  const named = ctx.repo?.refs.find((ref) => ref.name === typed);
  const item = collectRefItems(ctx)[ctx.selected];

  if (named !== undefined) {
    applyRef(flow, { ref: named.name, sha: named.sha });

    return;
  }

  if (COMMIT_ID_PATTERN.test(typed)) {
    applyRef(flow, { ref: null, sha: typed });

    return;
  }

  // An abbreviated commit id could name another commit by the time the
  // clone runs, so only a full one pins the checkout.
  if (SHORT_SHA_PATTERN.test(typed)) {
    ctx.refusal = 'full commit id required · esc back';

    renderFlow(flow);

    return;
  }

  if (item !== undefined) {
    applyRef(flow, { ref: item.name, sha: item.sha });

    return;
  }

  if (typed === '' || ctx.repo === null) {
    return;
  }

  sendPending(flow, {
    kind: 'probe',
    label: `resolving ${typed}…`,
    params: { url: ctx.repo.url, ref: typed, ...buildTargetParam(ctx) },
    followUp: { kind: 'resolve', typed },
  });
}

export function applyRefCancel(flow: PickerFlow) {
  const ctx = flow.ctx;

  ctx.input = ctx.repo?.label ?? '';
  ctx.repo = null;
  ctx.step = 'source';

  renderFlow(flow, true);
}

export function applyResolveProbe(
  flow: PickerFlow,
  outcome: Extract<RequestOutcome, { readonly kind: 'probe' }>,
  typed: string,
) {
  const sha = outcome.result?.resolved?.sha ?? null;

  if (sha !== null) {
    applyRef(flow, { ref: typed, sha });

    return;
  }

  flow.ctx.refusal =
    outcome.result === null
      ? `${formatPickerError(outcome.error)} · esc back`
      : `the daemon resolved no commit for ${typed} · esc back`;

  renderFlow(flow, true);
}

export function applyRefreshProbe(
  flow: PickerFlow,
  outcome: Extract<RequestOutcome, { readonly kind: 'probe' }>,
  reason: string,
  repo: ProbedRepo,
) {
  if (outcome.result === null) {
    flow.ctx.refusal = `${reason} · ${formatPickerError(outcome.error)} · esc back`;
  } else {
    flow.ctx.repo = {
      label: repo.label,
      url: outcome.result.url,
      head: outcome.result.head,
      refs: outcome.result.refs,
    };

    flow.ctx.refusal = `refs re-read · ${reason} · esc back`;
  }

  renderFlow(flow, true);
}

function applyRef(flow: PickerFlow, ref: ChosenRef) {
  const ctx = flow.ctx;

  if (!ctx.destinationEdited) {
    ctx.destination = '';
  }

  ctx.ref = ref;
  ctx.input = '';

  openConfirmStep(flow);
  renderFlow(flow, true);
}
