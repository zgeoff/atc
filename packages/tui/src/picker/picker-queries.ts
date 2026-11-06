import { isPathInput } from '@atc/core';
import type { GitRef, SourceEntry } from '@atcx/contract';
import { match } from 'ts-pattern';
import type { TargetPick } from '../collect-target-picks';
import { pickMatches } from '../dirs';
import type { ItemMark, ListedCandidate, PickerContext, SourceListing } from './picker-flow';

export type ListItem =
  | {
      readonly kind: 'row';
      readonly sourceID: string;
      readonly shown: string;
      readonly candidate: ListedCandidate;
    }
  | { readonly kind: 'notice'; readonly sourceID: string; readonly shown: string }
  | {
      readonly kind: 'alternate';
      readonly sourceID: null;
      readonly shown: string;
      readonly url: string;
    };

function findSource(ctx: PickerContext): SourceEntry | null {
  return ctx.sources[ctx.sourceIndex] ?? null;
}

export function isGitFlow(ctx: PickerContext): boolean {
  return findSource(ctx)?.kind === 'git';
}

export function collectListItems(ctx: PickerContext): ListItem[] {
  if (ctx.alternateURL !== null) {
    return [
      {
        kind: 'alternate',
        sourceID: null,
        shown: `try ${ctx.alternateURL} instead`,
        url: ctx.alternateURL,
      },
    ];
  }

  if (isPathInput(ctx.input)) {
    return collectCompletionItems(ctx);
  }

  const filter = ctx.input.trim();

  if (filter === '') {
    return ctx.sources.flatMap((source) => {
      const listing = ctx.listings.get(source.id);

      return listing === undefined ? [] : collectGroupItems(source, listing);
    });
  }

  const byLabel = new Map<string, ListItem>();

  for (const source of ctx.sources) {
    for (const candidate of ctx.listings.get(source.id)?.rows ?? []) {
      const label = formatRowLabel(source, candidate);

      if (!byLabel.has(label)) {
        byLabel.set(label, buildRowItem(source, candidate));
      }
    }
  }

  return pickMatches([...byLabel.keys()], filter).flatMap((label) => {
    const item = byLabel.get(label);

    return item === undefined ? [] : [item];
  });
}

function collectCompletionItems(ctx: PickerContext): ListItem[] {
  const completed = ctx.completed;

  if (completed?.input !== ctx.input) {
    return [];
  }

  return [...completed.labels].map(([directory, label]) => ({
    kind: 'row',
    sourceID: completed.sourceID,
    shown: label,
    candidate: {
      sourceID: completed.sourceID,
      label,
      detail: null,
      pick: { kind: 'path', directory },
    },
  }));
}

function collectGroupItems(source: SourceEntry, listing: SourceListing): ListItem[] {
  const rows = listing.rows.map((candidate) => buildRowItem(source, candidate));
  const notice = findGroupNotice(listing);

  return notice === null
    ? rows
    : [...rows, { kind: 'notice', sourceID: source.id, shown: `${source.id}: ${notice}` }];
}

function findGroupNotice(listing: SourceListing): string | null {
  return match(listing.status)
    .with('listing', () => (listing.listedFrom === null ? 'listing…' : listing.notice))
    .with('failed', () => (listing.listedFrom === null ? listing.notice : null))
    .with('skipped', 'listed', () => listing.notice)
    .exhaustive();
}

function buildRowItem(source: SourceEntry, candidate: ListedCandidate): ListItem {
  const label = formatRowLabel(source, candidate);

  return {
    kind: 'row',
    sourceID: source.id,
    shown: candidate.detail === null ? label : `${label}  ${candidate.detail}`,
    candidate,
  };
}

function formatRowLabel(source: SourceEntry, candidate: ListedCandidate): string {
  return match(source.kind)
    .with('git', () => `${source.id}:${candidate.label}`)
    .with('path', () => candidate.label)
    .exhaustive();
}

export function buildItemMark(item: ListItem | undefined): ItemMark {
  return {
    sourceID: item?.sourceID ?? null,
    label: item?.kind === 'row' ? item.candidate.label : null,
  };
}

export function getListItemIndex(items: readonly ListItem[], mark: ItemMark): number {
  const same = items.findIndex(
    (item) =>
      item.sourceID === mark.sourceID &&
      (item.kind === 'row' ? item.candidate.label === mark.label : mark.label === null),
  );

  if (same !== -1) {
    return same;
  }

  return Math.max(
    0,
    items.findIndex((item) => item.sourceID === mark.sourceID),
  );
}

export function pickListingTarget(targets: readonly TargetPick[]): TargetPick | null {
  return (
    targets.find((target) => target.isDefault && target.takesWorkspace) ??
    targets.find((target) => target.takesWorkspace) ??
    null
  );
}

export function collectRefItems(ctx: PickerContext): GitRef[] {
  const refs = ctx.repo?.refs ?? [];
  const head = ctx.repo?.head ?? null;

  const ordered = [
    ...refs.filter((ref) => ref.kind === 'branch' && ref.name === head),
    ...refs.filter((ref) => !(ref.kind === 'branch' && ref.name === head)),
  ];

  const names = pickMatches([...new Set(ordered.map((ref) => ref.name))], ctx.input.trim());

  return names.flatMap((name) => ordered.filter((ref) => ref.name === name));
}

export function getSelectedIndex(ctx: PickerContext): number {
  return match(ctx.step)
    .with('agent', () => Math.min(ctx.selected, ctx.picks.length - 1))
    .with('target', () => Math.min(ctx.selected, ctx.targets.length - 1))
    .with('list', () => clampToItems(ctx.selected, collectListItems(ctx).length))
    .with('ref', () => clampToItems(ctx.selected, collectRefItems(ctx).length))
    .with('confirm', 'name', 'prompt', 'spawned', () => ctx.selected)
    .exhaustive();
}

export function collectEligibleTargets(ctx: PickerContext, git: boolean): TargetPick[] {
  return ctx.targets.filter((target) => findTargetRefusal(target, git) === null);
}

export function findEffectiveTarget(ctx: PickerContext): TargetPick | null {
  return ctx.target ?? ctx.targets.find((target) => target.isDefault) ?? null;
}

export function findTargetRefusal(pick: TargetPick, git: boolean): string | null {
  if (!pick.available) {
    return `target '${pick.id}' is unavailable on this daemon · esc back`;
  }

  if (!pick.takesWorkspace && (git || !pick.inPlace)) {
    return `target '${pick.id}' cannot take a workspace · esc back`;
  }

  return null;
}

export function buildDestination(ctx: PickerContext): string {
  return ctx.destinationAttempt === 1
    ? ctx.destination
    : `${ctx.destination}-${ctx.destinationAttempt}`;
}

function clampToItems(selected: number, items: number): number {
  return Math.min(selected, Math.max(0, items - 1));
}
