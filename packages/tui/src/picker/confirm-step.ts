import { expandHome } from '@atc/core';
import { openRefStep, renderFlow } from './navigate-picker';
import type { PickerFlow } from './picker-flow';
import { buildDestination, findEffectiveTarget } from './picker-queries';

export function applyConfirmSubmit(flow: PickerFlow) {
  const ctx = flow.ctx;

  if (!applyDestination(flow, ctx.input.trim())) {
    renderFlow(flow);

    return;
  }

  ctx.input = ctx.name;
  ctx.step = 'name';

  renderFlow(flow, true);
}

export function applyConfirmCancel(flow: PickerFlow) {
  openRefStep(flow);
  renderFlow(flow, true);
}

function applyDestination(flow: PickerFlow, typed: string): boolean {
  const ctx = flow.ctx;
  const deps = flow.deps;

  if (typed === '' && ctx.autoDestination !== null) {
    ctx.destinationRepoURL = ctx.repo?.url ?? null;
    ctx.directory = '';

    return true;
  }

  const inPlace = findEffectiveTarget(ctx)?.inPlace ?? true;
  const directory = inPlace ? expandHome(typed, deps.home) : typed;

  if (!directory.startsWith('/')) {
    ctx.refusal = inPlace
      ? 'the destination must be an absolute path'
      : 'the destination must be an absolute path on the target; ~ is not expanded there';

    return false;
  }

  if (directory !== buildDestination(ctx)) {
    ctx.destination = directory;
    ctx.destinationAttempt = 1;
    ctx.destinationEdited = true;
  }

  ctx.autoDestination = null;
  ctx.destinationRepoURL = ctx.repo?.url ?? null;
  ctx.directory = buildDestination(ctx);

  return true;
}
