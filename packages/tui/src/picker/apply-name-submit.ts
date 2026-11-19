import { sendSpawn } from './apply-prompt-submit';
import { buildDestination, isGitFlow } from './collect-list-items';
import { openListAgain, openTargetStep, renderFlow } from './open-list';
import type { PickerFlow } from './picker-flow';

export function applyNameSubmit(flow: PickerFlow) {
  const ctx = flow.ctx;

  ctx.name = ctx.input.trim();
  ctx.input = '';

  // Adopt skips the prompt step: the agent's own resume picker opens inside
  // the new PTY.
  if (ctx.resume) {
    sendSpawn(flow, '');

    return;
  }

  ctx.step = 'prompt';

  renderFlow(flow, true);
}

export function applyNameCancel(flow: PickerFlow) {
  const ctx = flow.ctx;

  if (isGitFlow(ctx)) {
    ctx.input = buildDestination(ctx);
    ctx.step = 'confirm';
  } else if (!openTargetStep(flow)) {
    openListAgain(flow);

    return;
  }

  renderFlow(flow, true);
}
