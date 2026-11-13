import { isPathInput } from '@atc/core';
import { match } from 'ts-pattern';
import type { CompletionOutcome, ListingOutcome, RequestOutcome } from './create-picker-actors';
import { openAgentStep } from './daemon-step';
import { findAlternateURL, formatListFailure, formatPickerError } from './format-picker-error';
import {
  applyDir,
  applyReading,
  buildOwnRows,
  checkRepoAccess,
  collectSourceIndexes,
  openRefStep,
  readTypedInput,
  renderFlow,
  replaceListing,
  startGitPick,
  stopListings,
} from './navigate-picker';
import { parseCandidates } from './parse-picker-answers';
import type { ListedCandidate, ListingRequest, PickerFlow, SourceListing } from './picker-flow';
import { buildClientCwdParam, buildPathTargetParam } from './picker-params';
import { buildItemMark, collectListItems, getListItemIndex } from './picker-queries';
import type { ListItem } from './picker-queries';

export function applyListSubmit(flow: PickerFlow) {
  const ctx = flow.ctx;
  const typed = ctx.input.trim();
  const item = collectListItems(ctx)[ctx.selected];

  ctx.listMark = { input: ctx.input, ...buildItemMark(item) };

  if (item?.kind === 'alternate') {
    checkRepoAccess(flow, item.url, item.url);

    return;
  }

  const candidate = item?.kind === 'row' ? item.candidate : null;

  if (typed === '' || (isPathInput(typed) && candidate !== null)) {
    applyCandidate(flow, candidate);

    return;
  }

  // The git URL source reads any absolute path as a repository, so a typed
  // path goes to the path source first, as a directory.
  if (isPathInput(typed)) {
    readTypedInput(
      flow,
      typed,
      [...collectSourceIndexes(ctx, 'path'), ...collectGitIndexes(flow)],
      { kind: 'refuse' },
    );

    return;
  }

  const git = collectGitIndexes(flow);

  if (git.length > 0) {
    readTypedInput(flow, typed, git, { kind: 'list-fallback', candidate });

    return;
  }

  applyListFallback(flow, typed, candidate);
}

function collectGitIndexes(flow: PickerFlow): number[] {
  return flow.ctx.resume ? [] : collectSourceIndexes(flow.ctx, 'git');
}

function applyCandidate(flow: PickerFlow, candidate: ListedCandidate | null) {
  const ctx = flow.ctx;

  if (candidate === null) {
    return;
  }

  const index = ctx.sources.findIndex((source) => source.id === candidate.sourceID);

  match(candidate.pick)
    .with({ kind: 'path' }, (pick) => {
      applyDir(flow, index, pick.directory);
    })
    .with({ kind: 'git' }, (pick) => {
      startGitPick(flow, index, { label: candidate.label, url: pick.url });
    })
    .exhaustive();
}

function applyListFallback(flow: PickerFlow, typed: string, candidate: ListedCandidate | null) {
  if (candidate !== null) {
    applyCandidate(flow, candidate);

    return;
  }

  const paths = collectSourceIndexes(flow.ctx, 'path');

  if (paths.length > 0) {
    readTypedInput(flow, typed, paths, { kind: 'refuse' });

    return;
  }

  flow.ctx.refusal = `no source reads ${typed} · esc back`;

  renderFlow(flow, true);
}

export function applyListCancel(flow: PickerFlow) {
  stopListings(flow);

  flow.ctx.input = '';

  openAgentStep(flow);
}

export function applyListInput(flow: PickerFlow, value: string) {
  const ctx = flow.ctx;

  ctx.alternateURL = null;
  ctx.selected = 0;

  if (isPathInput(value)) {
    scheduleCompletion(flow, value);
  }

  renderFlow(flow);
}

function scheduleCompletion(flow: PickerFlow, input: string) {
  const ctx = flow.ctx;
  const deps = flow.deps;
  const source = ctx.sources.find((entry) => entry.kind === 'path');

  if (source === undefined) {
    return;
  }

  ctx.completion = {
    input,
    sourceID: source.id,
    params: {
      source: source.id,
      input,
      ...buildPathTargetParam(ctx),
      ...buildClientCwdParam(ctx, deps),
    },
  };

  flow.effects.push({ kind: 'complete' });
}

export function applyListTab(flow: PickerFlow) {
  const ctx = flow.ctx;
  const items = collectListItems(ctx);

  const next = pickNextSourceItem(
    items,
    ctx.sources.map((source) => source.id),
    items[ctx.selected]?.sourceID ?? null,
  );

  if (next === null) {
    flow.effects.push({ kind: 'log', line: 'ignored tab with no other source in the list' });

    return;
  }

  ctx.selected = next;

  renderFlow(flow);
}

function pickNextSourceItem(
  items: readonly ListItem[],
  order: readonly string[],
  current: string | null,
): number | null {
  const start = current === null ? -1 : order.indexOf(current);

  for (let step = 1; step <= order.length; step += 1) {
    const sourceID = order[(start + step) % order.length];
    const index = items.findIndex((item) => item.sourceID === sourceID);

    if (sourceID !== current && index !== -1) {
      return index;
    }
  }

  return null;
}

export function applyListing(flow: PickerFlow, outcome: ListingOutcome) {
  const ctx = flow.ctx;
  const request = outcome.request;
  const listing = ctx.listings.get(request.sourceID);

  if (listing === undefined) {
    flow.effects.push({ kind: 'log', line: `dropped a listing of ${request.sourceID}` });

    return;
  }

  const chosen = buildItemMark(collectListItems(ctx)[ctx.selected]);

  replaceListing(ctx, request.sourceID, buildAnsweredListing(flow, outcome, listing));

  if (ctx.step !== 'list') {
    flow.effects.push({ kind: 'log', line: `kept the ${ctx.step} step through a listing answer` });

    return;
  }

  ctx.selected = getListItemIndex(collectListItems(ctx), chosen);

  renderFlow(flow, true);
}

function buildAnsweredListing(
  flow: PickerFlow,
  outcome: ListingOutcome,
  listing: SourceListing,
): SourceListing {
  const request = outcome.request;

  if (outcome.answer === null) {
    const failure = describeListingFailure(request, outcome.error);

    flow.effects.push({ kind: 'log', line: `listing ${request.sourceID} failed: ${failure}` });

    return { ...listing, status: 'failed', notice: failure };
  }

  const answered = outcome.answer['scope'];
  const scope = typeof answered === 'string' ? answered : listing.requestedScope;
  const listed = parseCandidates(outcome.answer['candidates'], request.sourceID);

  const own = match(request)
    .with({ kind: 'path' }, (path) =>
      listing.requestedScope === null ? buildOwnRows(flow, path.sourceID) : [],
    )
    .with({ kind: 'git' }, () => [])
    .exhaustive();

  const rows = mergeOwnRows(own, listed);

  return {
    status: 'listed',
    rows,
    requestedScope: listing.requestedScope,
    scope,
    notice: rows.length === 0 && scope !== null ? `nothing listed for ${scope}` : null,
    listedFrom: null,
  };
}

function describeListingFailure(request: ListingRequest, error: unknown): string {
  return match(request)
    .with({ kind: 'path' }, () => formatPickerError(error))
    .with({ kind: 'git' }, () => formatListFailure(error))
    .exhaustive();
}

function mergeOwnRows(
  own: readonly ListedCandidate[],
  listed: readonly ListedCandidate[],
): ListedCandidate[] {
  const byPick = new Map<string, ListedCandidate>();

  for (const row of [...own, ...listed]) {
    const key = match(row.pick)
      .with({ kind: 'path' }, (pick) => pick.directory)
      .with({ kind: 'git' }, (pick) => pick.url)
      .exhaustive();

    if (!byPick.has(key)) {
      byPick.set(key, row);
    }
  }

  return [...byPick.values()];
}

export function applyCompletion(flow: PickerFlow, outcome: CompletionOutcome) {
  const ctx = flow.ctx;
  const input = outcome.request.input;

  ctx.completion = null;

  if (outcome.failure !== null) {
    flow.effects.push({ kind: 'log', line: `path completion failed: ${outcome.failure}` });

    ctx.refusal = `cannot complete ${input}: ${outcome.failure}`;
    ctx.completed = null;

    renderFlow(flow);

    return;
  }

  const labels = new Map(
    outcome.candidates.flatMap((candidate) =>
      candidate.pick.kind === 'path' ? [[candidate.pick.directory, candidate.label] as const] : [],
    ),
  );

  ctx.completed = { input, sourceID: outcome.request.sourceID, labels };

  renderFlow(flow);
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

  match(outcome.request.followUp)
    .with({ kind: 'list-fallback' }, (followUp) => {
      applyListFallback(flow, typed, followUp.candidate);
    })
    .with({ kind: 'refuse' }, () => {
      flow.ctx.refusal =
        outcome.failures.length === 0
          ? `no source reads ${typed} · esc back`
          : `cannot read ${typed}: ${outcome.failures.join(' · ')} · esc back`;

      renderFlow(flow, true);
    })
    .exhaustive();
}

export function applyAccessProbe(
  flow: PickerFlow,
  outcome: Extract<RequestOutcome, { readonly kind: 'probe' }>,
  label: string,
) {
  const ctx = flow.ctx;

  if (outcome.result === null) {
    ctx.step = 'list';
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
