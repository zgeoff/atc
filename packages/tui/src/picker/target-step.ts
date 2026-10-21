import { openAgentStep, openPathSource, openSourceStep, renderFlow } from './navigate-picker';
import type { PickerFlow } from './picker-flow';
import { findTargetRefusal, isGitFlow } from './picker-queries';

export function applyTargetSubmit(flow: PickerFlow) {
  const ctx = flow.ctx;
  const pick = ctx.targets[ctx.selected];

  if (pick === undefined) {
    return;
  }

  const refusal = findTargetRefusal(pick, isGitFlow(ctx));

  if (refusal !== null) {
    ctx.refusal = refusal;

    renderFlow(flow);

    return;
  }

  if (pick.id !== ctx.target?.id && !ctx.destinationEdited) {
    ctx.destination = '';
  }

  ctx.target = pick;
  ctx.input = '';

  if (isGitFlow(ctx)) {
    openSourceStep(flow);

    return;
  }

  ctx.step = 'name';

  renderFlow(flow, true);
}

export function applyTargetCancel(flow: PickerFlow) {
  const ctx = flow.ctx;

  ctx.sourceAction = { kind: 'none' };

  if (!isGitFlow(ctx)) {
    ctx.step = 'dir';

    renderFlow(flow, true);

    return;
  }

  const index = ctx.sources.findIndex((source) => source.kind === 'path');

  if (index === -1) {
    openAgentStep(flow);

    return;
  }

  openPathSource(flow, index, null);
}
