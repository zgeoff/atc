import { openAgentMenu } from './agent-step';
import { quitFlow, renderFlow } from './navigate-picker';
import type { PickerFlow } from './picker-flow';

// The picker opens on the primary daemon, and asks which daemon to spawn on only when another
// daemon is up beside it.
export function openFirstStep(flow: PickerFlow) {
  const ctx = flow.ctx;
  const deps = flow.deps;
  const up = deps.upDaemons();

  ctx.daemon = deps.primaryDaemon;
  ctx.agent = deps.getLastUsedAgent(ctx.daemon);

  if (up.length === 0 || (up.length === 1 && up[0] === deps.primaryDaemon)) {
    ctx.daemons = [];

    openAgentMenu(flow);

    return;
  }

  ctx.daemons = up;

  openDaemonStep(flow);
}

function openDaemonStep(flow: PickerFlow) {
  const ctx = flow.ctx;

  ctx.step = 'daemon';
  ctx.input = '';
  ctx.agentStepWait = null;
  ctx.pending = null;
  ctx.selected = Math.max(0, ctx.daemons.indexOf(ctx.daemon));

  flow.effects.push({ kind: 'cancel-request' });

  renderFlow(flow, true);
}

export function applyDaemonSubmit(flow: PickerFlow) {
  const ctx = flow.ctx;
  const picked = ctx.daemons[ctx.selected];

  if (picked === undefined) {
    return;
  }

  ctx.daemon = picked;
  ctx.step = 'agent';
  ctx.input = '';
  ctx.agent = flow.deps.getLastUsedAgent(picked);

  openAgentMenu(flow);
}

export function applyDaemonCancel(flow: PickerFlow) {
  quitFlow(flow);
}

// The agent step goes back to the daemon step when the picker showed one, and leaves otherwise.
export function applyAgentCancel(flow: PickerFlow) {
  if (flow.ctx.daemons.length > 0) {
    openDaemonStep(flow);

    return;
  }

  quitFlow(flow);
}

export function openAgentStep(flow: PickerFlow) {
  const ctx = flow.ctx;

  if (ctx.picks.length === 1) {
    applyAgentCancel(flow);

    return;
  }

  ctx.selected = Math.max(
    0,
    ctx.picks.findIndex((pick) => pick.agent === ctx.agent),
  );

  ctx.agentStepWait = null;
  ctx.step = 'agent';

  renderFlow(flow, true);
}
