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
import { parseCandidates, parseProbedRepo } from './parse-picker-answers';
import type { ListedCandidate, PickerFlow } from './picker-flow';
import { collectCandidateItems, findSource } from './picker-queries';

// Takes the git source step's choice: the other URL form on offer, a typed
// git URL, what the source reads typed text as, the selected candidate, or
// else what another source reads the text as.
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

// Esc first stops a listing in flight, keeping the step, unless the step
// shows a cached listing meanwhile. Otherwise it leaves the step backwards:
// to the target step when the spawn has one, else to the agent.
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

// Lists the git source step's scope again behind the step, keeping what it
// shows until the answer comes.
export function refreshCandidates(flow: PickerFlow) {
  const ctx = flow.ctx;

  ctx.listedKey = `${findSource(ctx)?.id ?? ''}\n${ctx.target?.id ?? ''}`;

  loadCandidates(flow, ctx.requestedScope);
}

// Fills the git source step from the listing the daemon answered, or from
// the notice or the refresh failure in place of one it could not give.
export function applyGitListing(flow: PickerFlow, outcome: GitListingOutcome) {
  const ctx = flow.ctx;
  const scope = outcome.request.scope;

  ctx.listing = null;

  // The row the source step has selected, which stays selected when the
  // fresh listing still holds it.
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

  // The list answers behind the flow, so only the source step's own
  // selection moves: to the row it had, else to the first.
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

// Moves the flow to the first reading a source took, or else shows why no
// source read the text, or goes on through the git source step's choice.
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

// Opens the ref step on the repository the probe proved the daemon's host
// can read, or stays on the source step with git's error and the other URL
// form the daemon returns.
export function applyAccessProbe(
  flow: PickerFlow,
  outcome: Extract<RequestOutcome, { readonly kind: 'probe' }>,
  label: string,
  url: string,
) {
  const ctx = flow.ctx;

  if (outcome.answer === null) {
    ctx.alternateURL = findAlternateURL(outcome.error);
    ctx.selected = 0;
    ctx.refusal = `${formatPickerError(outcome.error)} · esc back`;
    ctx.input = label;

    renderFlow(flow, true);

    return;
  }

  const repo = parseProbedRepo(label, url, outcome.answer);

  // A destination typed for one repository is not meant for another.
  if (repo.url !== ctx.destinationRepoURL) {
    ctx.destinationEdited = false;
    ctx.destination = '';
  }

  ctx.repo = repo;
  ctx.ref = null;

  openRefStep(flow);
  renderFlow(flow, true);
}

// The selected candidate when it is a repository, else what the other
// sources read the typed text as.
function applySourceFallback(flow: PickerFlow, typed: string, candidate: ListedCandidate | null) {
  if (candidate?.pick.kind === 'git') {
    checkRepoAccess(flow, candidate.label, candidate.pick.url);

    return;
  }

  if (typed !== '') {
    readTypedInput(flow, typed, collectReadOrder(flow, false), { kind: 'refuse' });
  }
}
