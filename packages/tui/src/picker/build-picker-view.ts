import { LOCAL_TARGET } from '@atc/config';
import { formatHomePath } from '@atc/core';
import type { GitRef } from '@atcx/contract';
import { match } from 'ts-pattern';
import type { TargetPick } from '../collect-target-picks';
import { formatDirName } from '../dirs';
import { splitToWidth } from '../split-to-width';
import { getPickerWidth } from '../ui';
import type { PickerView } from '../ui';
import type { PickerContext, PickerDeps, SourceListing } from './picker-flow';
import {
  buildDestination,
  collectEligibleTargets,
  collectListItems,
  collectRefItems,
  findEffectiveTarget,
  isGitFlow,
} from './picker-queries';

export function buildPickerView(ctx: PickerContext, deps: PickerDeps): PickerView {
  const verb = ctx.resume ? 'adopt' : 'spawn';

  return match(ctx.step)
    .with('agent', () => buildAgentView(ctx, verb))
    .with('list', () => buildListView(ctx, deps, verb))
    .with('ref', () => buildRefView(ctx))
    .with('target', () => buildTargetView(ctx, deps.home, verb))
    .with('confirm', () => buildConfirmView(ctx))
    .with('spawned', () => ({
      title: `${verb}: started`,
      items: ctx.spawnedWarnings.flatMap((warning) => splitToWidth(warning, getPickerWidth() - 4)),
      selected: -1,
      input: '',
      hint: '⏎ attach · esc back',
    }))
    .with('name', () => {
      const where = isGitFlow(ctx)
        ? formatDestination(ctx)
        : formatHomePath(ctx.directory, deps.home);

      return {
        title: `${verb}: name`,
        items: [],
        selected: -1,
        input: ctx.input,
        placeholder: formatDirName(ctx.autoDestination ?? ctx.directory),
        hint: ctx.refusal ?? `session name for ${where} · ⏎ accept · esc back`,
      };
    })
    .with('prompt', () => ({
      title: 'spawn: initial prompt',
      items: [],
      selected: -1,
      input: ctx.input,
      placeholder: 'optional — ⏎ to start interactive',
      hint:
        ctx.pending?.label ?? ctx.refusal ?? 'first message for the session · ⏎ spawn · esc back',
    }))
    .exhaustive();
}

function buildAgentView(ctx: PickerContext, verb: string): PickerView {
  let hint = '↑↓ move · ⏎ select · esc cancel';

  if (ctx.agentStepWait !== null) {
    hint = `${ctx.agentStepWait} · esc cancel`;
  } else if (ctx.picks.length === 0) {
    hint = 'the daemon can start no agent — check agents and targets in config.json · esc cancel';
  }

  return {
    title: `${verb}: agent`,
    items: ctx.picks.map((pick) => pick.label),
    selected: ctx.selected,
    input: ctx.input,
    hint: ctx.refusal ?? hint,
  };
}

function buildListView(ctx: PickerContext, deps: PickerDeps, verb: string): PickerView {
  const items = collectListItems(ctx);
  const git = [...ctx.listings].filter(([sourceID]) => isGitSource(ctx, sourceID));
  const marks = git.flatMap(([sourceID, listing]) => formatListingMark(sourceID, listing, deps));

  const failed = git.find(
    ([, listing]) => listing.status === 'failed' && listing.listedFrom !== null,
  );

  // An 80-column terminal leaves the hint row 72 characters, so the keys of
  // a git source take the place of the path aside and the arrow keys.
  const keys = [
    ...(git.length > 0
      ? ['type to filter', '⏎ select', '^r refresh']
      : ['type to filter, or a path (/ ~ .)', '↑↓ move', '⏎ select']),
    ...(!ctx.resume && ctx.listings.size > 1 ? ['tab next source'] : []),
    'esc back',
  ];

  return {
    title: [`${verb}: workspace`, ...marks].join(' · '),
    items: items.map((item) => item.shown),
    selected: items.length === 0 ? -1 : ctx.selected,
    input: ctx.input,
    hint:
      ctx.pending?.label ??
      ctx.refusal ??
      (failed === undefined
        ? keys.join(' · ')
        : `${failed[0]}: refresh failed: ${failed[1].notice ?? ''} · ^r retry · esc back`),
    dimmed: new Set(items.flatMap((item, index) => (item.kind === 'notice' ? [index] : []))),
  };
}

function isGitSource(ctx: PickerContext, sourceID: string): boolean {
  return ctx.sources.some((source) => source.id === sourceID && source.kind === 'git');
}

function formatListingMark(sourceID: string, listing: SourceListing, deps: PickerDeps): string[] {
  const age =
    listing.listedFrom === null
      ? null
      : `${formatAge(deps.clock.now() - listing.listedFrom)} old${listing.status === 'listing' ? ', refreshing…' : ''}`;

  const parts = [listing.scope, age].filter((part) => part !== null);

  return parts.length === 0 ? [] : [`${sourceID}: ${parts.join(' · ')}`];
}

function formatAge(ageMs: number): string {
  const minutes = Math.floor(ageMs / 60_000);

  if (minutes < 1) {
    return 'under 1m';
  }

  if (minutes < 60) {
    return `${minutes}m`;
  }

  return `${Math.floor(minutes / 60)}h`;
}

function buildRefView(ctx: PickerContext): PickerView {
  const items = collectRefItems(ctx);

  return {
    title: `spawn: ref · ${ctx.repo?.label ?? ''}`,
    items: items.map((item) => formatRef(item, ctx.repo?.head ?? null)),
    selected: items.length === 0 ? -1 : ctx.selected,
    input: ctx.input,
    hint:
      ctx.pending?.label ??
      ctx.refusal ??
      'branch, tag, or full commit id · ↑↓ move · ⏎ select · esc back',
  };
}

function formatRef(ref: GitRef, head: string | null): string {
  const notes = [
    ...(ref.kind === 'tag' ? ['tag'] : []),
    ...(ref.kind === 'branch' && ref.name === head ? ['default'] : []),
    ref.sha.slice(0, 7),
  ];

  return `${ref.name}  ${notes.join(' · ')}`;
}

function buildTargetView(ctx: PickerContext, home: string, verb: string): PickerView {
  const git = isGitFlow(ctx);
  const what = git ? 'the repository' : formatHomePath(ctx.directory, home);
  let hint = `where ${what} runs · ↑↓ move · ⏎ select · esc back`;

  if (collectEligibleTargets(ctx, git).length === 0) {
    const gap = ctx.targetGap ?? `none of these targets can run ${what}`;

    hint = `${gap} · set targets in config.json · esc back`;
  }

  return {
    title: `${verb}: target`,
    items: ctx.targets.map((target) => formatTargetPick(target)),
    selected: ctx.selected,
    input: '',
    hint: ctx.refusal ?? hint,
    dimmed: new Set(
      ctx.targets.flatMap((target, index) =>
        target.takesWorkspace || (!git && target.available && target.inPlace) ? [] : [index],
      ),
    ),
  };
}

function formatTargetPick(pick: TargetPick): string {
  const notes = [
    pick.provider,
    ...(pick.isDefault ? ['default'] : []),
    ...(pick.available ? [] : ['unavailable']),
    ...(pick.available && !pick.takesWorkspace ? ['no workspace'] : []),
  ];

  return `${pick.id}  ${notes.join(' · ')}`;
}

function buildConfirmView(ctx: PickerContext): PickerView {
  const ref = ctx.ref;
  const target = findEffectiveTarget(ctx);
  let refRow = '';

  if (ref !== null) {
    refRow = ref.ref === null ? `commit ${ref.sha}` : `${ref.ref} → ${ref.sha.slice(0, 12)}`;
  }

  return {
    title: 'spawn: confirm',
    items: [
      `source  ${ctx.repo?.url ?? ''}`,
      `ref     ${refRow}`,
      `target  ${target === null ? 'default' : `${target.id} (${target.provider})`}`,
      `dest    ${formatDestination(ctx)}`,
      `agent   ${ctx.agent}`,
    ],
    selected: -1,
    input: ctx.input,
    placeholder:
      ctx.autoDestination === null
        ? 'destination on the target'
        : 'picked on the target · or type an absolute path',
    hint: ctx.refusal ?? 'destination on the target · ⏎ continue · esc back',
  };
}

function formatDestination(ctx: PickerContext): string {
  const target = findEffectiveTarget(ctx)?.id ?? LOCAL_TARGET.id;

  return ctx.autoDestination === null
    ? `${target}:${buildDestination(ctx)}`
    : `${target}:${ctx.autoDestination}`;
}
