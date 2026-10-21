import { LOCAL_TARGET } from '@atc/config';
import type { GitRef } from '@atc/protocol';
import { match } from 'ts-pattern';
import type { TargetPick } from '../collect-target-picks';
import { formatDir, formatDirName } from '../dirs';
import { splitToWidth } from '../split-to-width';
import { getPickerWidth } from '../ui';
import type { PickerView } from '../ui';
import type { PickerContext, PickerDeps } from './picker-flow';
import {
  buildDestination,
  collectCandidateItems,
  collectDirItems,
  collectEligibleTargets,
  collectRefItems,
  findEffectiveTarget,
  findSource,
  isGitFlow,
} from './picker-queries';

export function buildPickerView(ctx: PickerContext, deps: PickerDeps): PickerView {
  const verb = ctx.resume ? 'adopt' : 'spawn';

  return match(ctx.step)
    .with('agent', () => buildAgentView(ctx, verb))
    .with('dir', () => buildDirView(ctx, deps, verb))
    .with('source', () => buildSourceView(ctx, deps))
    .with('ref', () => buildRefView(ctx))
    .with('target', () => buildTargetView(ctx, verb))
    .with('confirm', () => buildConfirmView(ctx))
    .with('spawned', () => ({
      title: `${verb}: started`,
      items: ctx.spawnedWarnings.flatMap((warning) => splitToWidth(warning, getPickerWidth() - 4)),
      selected: -1,
      input: '',
      hint: '⏎ attach · esc back',
    }))
    .with('name', () => {
      const where = isGitFlow(ctx) ? formatDestination(ctx) : formatDir(ctx.directory);

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

function buildDirView(ctx: PickerContext, deps: PickerDeps, verb: string): PickerView {
  // This host's home stands for nothing on a remote daemon's host.
  const items = collectDirItems(ctx).map(
    (directory) =>
      ctx.completed?.labels.get(directory) ??
      ctx.dirLabels.get(directory) ??
      (deps.remoteDaemon === true ? directory : formatDir(directory)),
  );

  return {
    title: `${verb}: ${findSource(ctx)?.label ?? 'directory'}`,
    items,
    selected: ctx.selected,
    input: ctx.input,
    hint:
      ctx.pending?.label ??
      ctx.refusal ??
      `type to filter, or a path (/ ~ .) · ↑↓ move · ⏎ select${formatTabHint(ctx)} · esc cancel`,
  };
}

function formatTabHint(ctx: PickerContext): string {
  if (ctx.resume || ctx.sources.length < 2) {
    return '';
  }

  const next = ctx.sources[(ctx.sourceIndex + 1) % ctx.sources.length];

  return next === undefined ? '' : ` · tab ${next.label}`;
}

function buildSourceView(ctx: PickerContext, deps: PickerDeps): PickerView {
  const items = collectCandidateItems(ctx);
  const scope = ctx.listedScope === null ? '' : ` · ${ctx.listedScope}`;
  let listing: string | null = null;
  let age = '';

  if (ctx.listedFrom !== null) {
    const refreshing = ctx.listing === null ? '' : ', refreshing…';

    age = ` · ${formatAge(deps.clock.now() - ctx.listedFrom)} old${refreshing}`;

    if (ctx.refreshFailure !== null && ctx.listing === null) {
      listing = `refresh failed: ${ctx.refreshFailure} · ^r retry · esc back`;
    }
  } else if (ctx.listing !== null) {
    listing = 'listing… · esc stops';
  }

  return {
    title: `spawn: ${findSource(ctx)?.label ?? ''}${scope}${age}`,
    items: items.map((item) => item.label),
    selected: items.length === 0 || items[0]?.notice === true ? -1 : ctx.selected,
    input: ctx.input,
    hint:
      ctx.pending?.label ??
      ctx.refusal ??
      listing ??
      `type to filter, or a git URL · ↑↓ move · ⏎ select · ^r refresh${formatTabHint(ctx)} · esc back`,
    dimmed: new Set(items.flatMap((item, index) => (item.notice === true ? [index] : []))),
  };
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

function buildTargetView(ctx: PickerContext, verb: string): PickerView {
  const git = isGitFlow(ctx);
  const what = git ? 'the repository' : formatDir(ctx.directory);
  let hint = `where ${what} runs · ↑↓ move · ⏎ select · esc back`;

  if (collectEligibleTargets(ctx).length === 0) {
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
