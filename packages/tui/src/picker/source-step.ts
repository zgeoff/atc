import { isGitURL } from '@atc/core';
import type { GitListingOutcome, RequestOutcome } from './create-picker-actors';
import { findAlternateURL, formatListFailure, formatPickerError } from './format-picker-error';
import {
  applyReading,
  checkRepoAccess,
  collectReadOrder,
  loadCandidates,
  openAgentStep,
  openRefStep,
  openTargetStep,
  readTypedInput,
  renderFlow,
} from './navigate-picker';
import { parseCandidates } from './parse-picker-answers';
import type { ListedCandidate, PickerFlow } from './picker-flow';
import { collectCandidateItems, findSource } from './picker-queries';

export function applySourceSubmit(flow: PickerFlow) {
  const ctx = flow.ctx;
  const typed = ctx.input.trim();
  const item = collectCandidateItems(ctx)[ctx.selected];

  if (item?.url !== undefined) {
    checkRepoAccess(flow, item.url, item.url);

    return;
  }

  if (isGitURL(typed)) {
    checkRepoAccess(flow, typed, typed);

    return;
  }

  if (typed !== '') {
    readTypedInput(flow, typed, [ctx.sourceIndex], {
      kind: 'source-fallback',
      candidate: item?.candidate ?? null,
    });

    return;
  }

  applySourceFallback(flow, typed, item?.candidate ?? null);
}

export function applySourceCancel(flow: PickerFlow) {
  const ctx = flow.ctx;

  if (ctx.listing !== null && ctx.listedFrom === null) {
    ctx.listing = null;
    ctx.listedKey = null;
    ctx.listNotice = 'listing stopped — type to enter one';

    flow.effects.push({ kind: 'cancel-git-listing' });

    renderFlow(flow);

    return;
  }

  ctx.sourceDraft = ctx.input;
  ctx.input = '';

  if (openTargetStep(flow)) {
    renderFlow(flow, true);

    return;
  }

  openAgentStep(flow);
}

export function applySourceInput(flow: PickerFlow) {
  flow.ctx.alternateURL = null;

  renderFlow(flow);
}

export function refreshCandidates(flow: PickerFlow) {
  const ctx = flow.ctx;

  ctx.listedKey = `${findSource(ctx)?.id ?? ''}\n${ctx.target?.id ?? ''}`;

  loadCandidates(flow, ctx.requestedScope);
}

export function applyGitListing(flow: PickerFlow, outcome: GitListingOutcome) {
  const ctx = flow.ctx;
  const scope = outcome.request.scope;

  ctx.listing = null;

  const chosen = collectCandidateItems(ctx)[ctx.selected]?.candidate?.label;

  if (outcome.answer === null && ctx.listedFrom !== null) {
    ctx.refreshFailure = formatListFailure(outcome.error);
  } else if (outcome.answer === null) {
    ctx.candidates = [];
    ctx.listedScope = scope;
    ctx.listNotice = `${formatListFailure(outcome.error)} — type to enter one`;
  } else {
    const answeredScope = outcome.answer['scope'];

    ctx.candidates = parseCandidates(outcome.answer['candidates']);
    ctx.listedScope = typeof answeredScope === 'string' ? answeredScope : scope;
    ctx.listedFrom = null;
    ctx.refreshFailure = null;

    ctx.listNotice =
      ctx.candidates.length === 0 && ctx.listedScope !== null
        ? `nothing listed for ${ctx.listedScope}`
        : null;
  }

  if (ctx.step === 'source') {
    ctx.selected = Math.max(
      0,
      collectCandidateItems(ctx).findIndex((item) => item.candidate?.label === chosen),
    );

    renderFlow(flow, true);

    return;
  }

  flow.effects.push({ kind: 'log', line: `kept the ${ctx.step} step through a listing answer` });
}

export function applyReadOutcome(
  flow: PickerFlow,
  outcome: Extract<RequestOutcome, { readonly kind: 'read' }>,
) {
  const typed = outcome.request.typed;

  if (outcome.accepted !== null) {
    applyReading(flow, outcome.accepted.index, outcome.accepted.reading, typed);

    return;
  }

  if (outcome.request.followUp.kind === 'source-fallback') {
    applySourceFallback(flow, typed, outcome.request.followUp.candidate);

    return;
  }

  flow.ctx.refusal =
    outcome.failures.length === 0
      ? `no source reads ${typed} · esc back`
      : `cannot read ${typed}: ${outcome.failures.join(' · ')} · esc back`;

  renderFlow(flow, true);
}

export function applyAccessProbe(
  flow: PickerFlow,
  outcome: Extract<RequestOutcome, { readonly kind: 'probe' }>,
  label: string,
) {
  const ctx = flow.ctx;

  if (outcome.result === null) {
    ctx.alternateURL = findAlternateURL(outcome.error);
    ctx.selected = 0;
    ctx.refusal = `${formatPickerError(outcome.error)} · esc back`;
    ctx.input = label;

    renderFlow(flow, true);

    return;
  }

  const repo = {
    label,
    url: outcome.result.url,
    head: outcome.result.head,
    refs: outcome.result.refs,
  };

  if (repo.url !== ctx.destinationRepoURL) {
    ctx.destinationEdited = false;
    ctx.destination = '';
  }

  ctx.repo = repo;
  ctx.ref = null;

  openRefStep(flow);
  renderFlow(flow, true);
}

function applySourceFallback(flow: PickerFlow, typed: string, candidate: ListedCandidate | null) {
  if (candidate?.pick.kind === 'git') {
    checkRepoAccess(flow, candidate.label, candidate.pick.url);

    return;
  }

  if (typed !== '') {
    readTypedInput(flow, typed, collectReadOrder(flow, false), { kind: 'refuse' });
  }
}
