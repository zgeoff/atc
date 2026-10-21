import { isGitURL, isPathInput } from '@atc/core';
import type { GitRef, SourceEntry, SourceInterpretation } from '@atc/protocol';
import { match } from 'ts-pattern';
import type { TargetPick } from '../collect-target-picks';
import { pickMatches } from '../dirs';
import type { ListedCandidate, PickerContext } from './picker-flow';

export interface CandidateItem {
  readonly label: string;
  readonly notice?: boolean;
  readonly candidate?: ListedCandidate;
  readonly url?: string;
}

export function findSource(ctx: PickerContext): SourceEntry | null {
  return ctx.sources[ctx.sourceIndex] ?? null;
}

export function isGitFlow(ctx: PickerContext): boolean {
  return findSource(ctx)?.kind === 'git';
}

export function collectDirItems(ctx: PickerContext): string[] {
  if (!isPathInput(ctx.input)) {
    return pickMatches([...ctx.dirs], ctx.input);
  }

  return ctx.completed?.input === ctx.input ? [...ctx.completed.labels.keys()] : [];
}

export function collectCandidateItems(ctx: PickerContext): CandidateItem[] {
  if (ctx.alternateURL !== null) {
    return [{ label: `try ${ctx.alternateURL} instead`, url: ctx.alternateURL }];
  }

  if (ctx.listNotice !== null) {
    return [{ label: ctx.listNotice, notice: true }];
  }

  const filter = isGitURL(ctx.input) ? '' : ctx.input.trim();

  const byLabel = new Map(ctx.candidates.map((candidate) => [candidate.label, candidate]));

  return pickMatches([...byLabel.keys()], filter).flatMap((label) => {
    const candidate = byLabel.get(label);

    if (candidate === undefined) {
      return [];
    }

    return [
      {
        label: candidate.detail === null ? label : `${label}  ${candidate.detail}`,
        candidate,
      },
    ];
  });
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
    .with('dir', () => clampToRows(ctx.selected, collectDirItems(ctx).length))
    .with('source', () => clampToRows(ctx.selected, collectCandidateItems(ctx).length))
    .with('ref', () => clampToRows(ctx.selected, collectRefItems(ctx).length))
    .with('confirm', 'name', 'prompt', 'spawned', () => ctx.selected)
    .exhaustive();
}

export function collectEligibleTargets(ctx: PickerContext): TargetPick[] {
  const git = isGitFlow(ctx);

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

export function canTakeReading(
  kind: SourceEntry['kind'] | undefined,
  reading: SourceInterpretation,
): boolean {
  return reading.kind === 'browse' || (reading.kind !== 'none' && reading.kind === kind);
}

export function buildDestination(ctx: PickerContext): string {
  return ctx.destinationAttempt === 1
    ? ctx.destination
    : `${ctx.destination}-${ctx.destinationAttempt}`;
}

function clampToRows(selected: number, items: number): number {
  return Math.min(selected, Math.max(0, Math.min(items, 10) - 1));
}
