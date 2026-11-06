import { checkRepoAccess, openListAgain, renderFlow } from './navigate-picker';
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

  const gitPick = ctx.gitPick;

  if (isGitFlow(ctx) && gitPick !== null) {
    openListAgain(flow);
    checkRepoAccess(flow, gitPick.label, gitPick.url);

    return;
  }

  ctx.step = 'name';

  renderFlow(flow, true);
}

export function applyTargetCancel(flow: PickerFlow) {
  flow.ctx.gitPick = null;

  openListAgain(flow);
}
